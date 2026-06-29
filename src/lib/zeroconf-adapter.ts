import { Platform } from 'react-native';
import Zeroconf, { type Service } from 'react-native-zeroconf';

import { pickConnectHost } from '@/lib/broker-host';
import { hasDevClientNativeModules } from '@/lib/native-modules';
import { notifyDiscoveryScanActive } from '@/lib/discovery-mode';
import {
  restartNativeDiscoveryScan,
  stopNativeDiscoveryWatching,
} from '@/lib/zeroconf-native';

import type { ServiceEntry } from '@/types/broker';
import {
  BROKER_SERVICE_TYPES,
  removeLeadingAndTrailingDots,
  serviceTypeFromFullName,
  toScanParts,
} from '@/lib/service-type';

export type ZeroconfDiscoveryAction = 'added' | 'removed' | 'resolved';

export type ZeroconfDiscoveryEvent = {
  action: ZeroconfDiscoveryAction;
  service: ServiceEntry;
};

type DiscoveryListener = (event: ZeroconfDiscoveryEvent) => void;
type BrokerServiceType = (typeof BROKER_SERVICE_TYPES)[number];

const ANDROID_IMPL = 'DNSSD';
const DOMAIN = 'local.';
const PLATFORM_SCAN_TYPES: readonly BrokerServiceType[] =
  Platform.OS === 'android' ? [BROKER_SERVICE_TYPES[0]] : BROKER_SERVICE_TYPES;
const ROTATE_SCAN_TYPES = PLATFORM_SCAN_TYPES.length > 1;
const INITIAL_WS_SLICE_MS = 15_000;
const SCAN_SLICE_MS = 8_000;
const IOS_NATIVE_SETTLE_MS = 400;

type ServiceWithBrowseKey = Service & { browseKey?: string };

let zeroconf: Zeroconf | null = null;
const activeTypes = new Set<string>();
const listeners = new Set<DiscoveryListener>();
const knownServiceTypes = new Map<string, string>();
const knownBrowseKeys = new Map<string, string>();
let wired = false;
let rotationTimer: ReturnType<typeof setInterval> | null = null;
let initialScanTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRestartTimer: ReturnType<typeof setTimeout> | null = null;
let rotationIndex = 0;
let scanGeneration = 0;
let scanSessionActive = false;
let currentScanType: BrokerServiceType | null = null;

function getZeroconf(): Zeroconf | null {
  if (!hasDevClientNativeModules()) return null;
  if (!zeroconf) {
    zeroconf = new Zeroconf();
  }
  return zeroconf;
}

function splitAddresses(addresses: string[] | undefined): { ipv4: string[]; ipv6: string[] } {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const address of addresses ?? []) {
    if (address.includes(':')) ipv6.push(address);
    else ipv4.push(address);
  }
  return { ipv4, ipv6 };
}

function mapService(
  service: ServiceWithBrowseKey,
  action: ZeroconfDiscoveryAction,
  fallbackType?: string,
): ServiceEntry | null {
  const type =
    fallbackType ??
    serviceTypeFromFullName(service.fullName ?? '') ??
    (service.fullName?.includes('_mqtt-wss._tcp') ? '_mqtt-wss._tcp.' : '_mqtt-ws._tcp.');

  const host = service.host || service.addresses?.[0] || 'Unknown';
  const { ipv4, ipv6 } = splitAddresses(service.addresses);
  const port = service.port ?? 0;
  const connectHost = pickConnectHost({ host, ipv4Addresses: ipv4, ipv6Addresses: ipv6 });

  return {
    name: service.name || `${type} Service`,
    type,
    host: connectHost,
    port: port > 0 ? port : 0,
    domain: 'local',
    discovered: true,
    resolved: action === 'resolved' && port > 0,
    source: 'discovered',
    txtRecord: service.txt ?? {},
    ipv4Addresses: ipv4,
    ipv6Addresses: ipv6,
  };
}

function rememberServiceType(name: string, type: string, browseKey?: string) {
  knownServiceTypes.set(name, type);
  if (browseKey) knownBrowseKeys.set(name, browseKey);
}

function emit(event: ZeroconfDiscoveryEvent) {
  listeners.forEach((listener) => listener(event));
}

function clearScanTimers() {
  if (initialScanTimer) {
    clearTimeout(initialScanTimer);
    initialScanTimer = null;
  }
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
  if (pendingRestartTimer) {
    clearTimeout(pendingRestartTimer);
    pendingRestartTimer = null;
  }
}

function invalidateScanSession() {
  scanGeneration += 1;
  scanSessionActive = false;
  clearScanTimers();
  activeTypes.clear();
  knownServiceTypes.clear();
  knownBrowseKeys.clear();
  currentScanType = null;
  rotationIndex = 0;
}

function stopNativeScan() {
  if (!hasDevClientNativeModules()) return;
  if (Platform.OS === 'android') {
    stopNativeDiscoveryWatching();
    return;
  }
  if (!zeroconf) return;
  try {
    zeroconf.stop(ANDROID_IMPL);
  } catch {
    /* stop while native browse is tearing down */
  }
}

function scanServiceType(serviceType: BrokerServiceType) {
  const z = getZeroconf();
  if (!z) return;

  currentScanType = serviceType;
  const { type, protocol } = toScanParts(serviceType);
  try {
    z.scan(type, protocol, DOMAIN, ANDROID_IMPL);
  } catch {
    scanSessionActive = false;
  }
}

function rotateScan(generation: number) {
  if (generation !== scanGeneration || !scanSessionActive || !ROTATE_SCAN_TYPES) return;

  const types = PLATFORM_SCAN_TYPES.filter((t) => activeTypes.has(t));
  if (types.length === 0) return;

  rotationIndex = (rotationIndex + 1) % types.length;
  scanServiceType(types[rotationIndex]);
}

function republishCachedServices() {
  const z = getZeroconf();
  if (!z) return;

  for (const [name, raw] of Object.entries(z.getServices())) {
    const fallbackType = knownServiceTypes.get(name) ?? PLATFORM_SCAN_TYPES[0];
    const withKey = raw as ServiceWithBrowseKey;
    if (knownBrowseKeys.has(name)) {
      withKey.browseKey = knownBrowseKeys.get(name);
    }
    const mapped = mapService(withKey, 'resolved', fallbackType);
    if (!mapped || mapped.port <= 0) continue;
    rememberServiceType(mapped.name, mapped.type, withKey.browseKey);
    emit({ action: 'resolved', service: mapped });
  }
}

function armScanSession() {
  if (!hasDevClientNativeModules()) return;

  const generation = scanGeneration;
  activeTypes.clear();
  for (const serviceType of PLATFORM_SCAN_TYPES) {
    activeTypes.add(serviceType);
  }

  scanSessionActive = true;
  rotationIndex = 0;
  scanServiceType(PLATFORM_SCAN_TYPES[0]);

  if (!ROTATE_SCAN_TYPES) return;

  initialScanTimer = setTimeout(() => {
    if (generation !== scanGeneration) return;
    initialScanTimer = null;
    rotateScan(generation);
    rotationTimer = setInterval(() => rotateScan(generation), SCAN_SLICE_MS);
  }, INITIAL_WS_SLICE_MS);
}

function scheduleNativeRestart(settleMs: number) {
  if (pendingRestartTimer) {
    clearTimeout(pendingRestartTimer);
  }

  pendingRestartTimer = setTimeout(() => {
    pendingRestartTimer = null;
    if (!hasDevClientNativeModules()) return;

    stopNativeScan();
    setTimeout(() => {
      if (!hasDevClientNativeModules()) return;
      armScanSession();
    }, settleMs);
  }, settleMs);
}

function wireEvents() {
  if (wired) return;
  const z = getZeroconf();
  if (!z) return;
  wired = true;

  z.on('error', (err: Error) => {
    console.warn('[zeroconf]', err.message);
  });

  z.on('found', (name: string) => {
    const raw = z.getServices()[name] as ServiceWithBrowseKey | undefined;
    if (!raw) return;
    const mapped = mapService(raw, 'added', currentScanType ?? undefined);
    if (!mapped) return;
    rememberServiceType(mapped.name, mapped.type, raw.browseKey);
    emit({ action: 'added', service: mapped });
  });

  z.on('resolved', (service: ServiceWithBrowseKey) => {
    const mapped = mapService(service, 'resolved', currentScanType ?? undefined);
    if (!mapped) return;
    rememberServiceType(mapped.name, mapped.type, service.browseKey);
    emit({ action: 'resolved', service: mapped });
  });

  z.on('remove', (name: string) => {
    const raw = z.getServices()[name] as ServiceWithBrowseKey | undefined;
    const fallbackType =
      knownServiceTypes.get(name) ?? currentScanType ?? '_mqtt-ws._tcp.';
    const browseKey = knownBrowseKeys.get(name);
    knownServiceTypes.delete(name);
    knownBrowseKeys.delete(name);

    if (!raw) {
      emit({
        action: 'removed',
        service: {
          name,
          type: fallbackType,
          host: 'Unknown',
          port: 0,
          discovered: true,
          resolved: false,
          source: 'discovered',
        },
      });
      return;
    }

    const mapped = mapService(raw, 'removed', fallbackType);
    if (mapped) emit({ action: 'removed', service: mapped });
  });
}

export function subscribeZeroconf(listener: DiscoveryListener): () => void {
  wireEvents();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startAllBrokerScans() {
  wireEvents();
  if (scanSessionActive) return;
  notifyDiscoveryScanActive(true);
  armScanSession();
}

export function softRefreshBrokerDiscovery() {
  wireEvents();
  republishCachedServices();
}

export function restartAllBrokerScans() {
  wireEvents();
  if (Platform.OS === 'android') {
    restartNativeDiscoveryScan();
    republishCachedServices();
    return;
  }

  scanGeneration += 1;
  scanSessionActive = false;
  clearScanTimers();
  stopNativeScan();
  scheduleNativeRestart(IOS_NATIVE_SETTLE_MS);
}

export function stopAllZeroconfScans() {
  invalidateScanSession();
  stopNativeScan();
  if (Platform.OS === 'android') {
    notifyDiscoveryScanActive(false);
  }
}

export function serviceEntryKey(service: ServiceEntry): string {
  const st = removeLeadingAndTrailingDots(service.type || '');
  return `${service.name || 'unknown'}_${service.domain || 'local'}_${st}`;
}

export function canSoftRefreshDiscovery(): boolean {
  return Platform.OS === 'android' && scanSessionActive;
}

/** @deprecated Use startAllBrokerScans */
export function startZeroconfScan(serviceType: string) {
  wireEvents();
  activeTypes.add(serviceType);
  if (!scanSessionActive) {
    startAllBrokerScans();
  }
}
