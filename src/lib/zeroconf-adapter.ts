import { Platform } from 'react-native';
import Zeroconf, { type Service } from 'react-native-zeroconf';

import { pickConnectHost } from '@/lib/broker-host';
import { hasDevClientNativeModules } from '@/lib/native-modules';

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
/**
 * Android embedded DNSSD (druk rx2dnssd) SIGSEGVs on rapid stop→browse while resolve
 * callbacks are in flight. Keep one long-lived _mqtt-ws browse; skip WSS rotation on LAN.
 */
const PLATFORM_SCAN_TYPES: readonly BrokerServiceType[] =
  Platform.OS === 'android' ? [BROKER_SERVICE_TYPES[0]] : BROKER_SERVICE_TYPES;
const ROTATE_SCAN_TYPES = PLATFORM_SCAN_TYPES.length > 1;
const INITIAL_WS_SLICE_MS = 15_000;
const SCAN_SLICE_MS = 8_000;
const IOS_NATIVE_SETTLE_MS = 400;
const ANDROID_RESTART_DEBOUNCE_MS = 2_500;

let zeroconf: Zeroconf | null = null;
const activeTypes = new Set<string>();
const listeners = new Set<DiscoveryListener>();
const knownServiceTypes = new Map<string, string>();
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
  service: Service,
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
    discoverySegment: 'upstream',
    txtRecord: service.txt ?? {},
    ipv4Addresses: ipv4,
    ipv6Addresses: ipv6,
  };
}

function rememberServiceType(name: string, type: string) {
  knownServiceTypes.set(name, type);
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
  currentScanType = null;
  rotationIndex = 0;
}

function stopNativeScan() {
  if (!hasDevClientNativeModules() || !zeroconf) return;
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
    const mapped = mapService(raw, 'resolved', fallbackType);
    if (!mapped || mapped.port <= 0) continue;
    rememberServiceType(mapped.name, mapped.type);
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
    const raw = z.getServices()[name];
    if (!raw) return;
    const mapped = mapService(raw, 'added', currentScanType ?? undefined);
    if (!mapped) return;
    rememberServiceType(mapped.name, mapped.type);
    emit({ action: 'added', service: mapped });
  });

  z.on('resolved', (service: Service) => {
    const mapped = mapService(service, 'resolved', currentScanType ?? undefined);
    if (!mapped) return;
    rememberServiceType(mapped.name, mapped.type);
    emit({ action: 'resolved', service: mapped });
  });

  z.on('remove', (name: string) => {
    const raw = z.getServices()[name];
    const fallbackType =
      knownServiceTypes.get(name) ?? currentScanType ?? '_mqtt-ws._tcp.';
    knownServiceTypes.delete(name);

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
  armScanSession();
}

/** Clear UI list and republish from JS cache — no native stop (Android refresh). */
export function softRefreshBrokerDiscovery() {
  wireEvents();
  republishCachedServices();
}

export function restartAllBrokerScans() {
  wireEvents();
  scanGeneration += 1;
  scanSessionActive = false;
  clearScanTimers();

  if (Platform.OS === 'android') {
    scheduleNativeRestart(ANDROID_RESTART_DEBOUNCE_MS);
    return;
  }

  stopNativeScan();
  scheduleNativeRestart(IOS_NATIVE_SETTLE_MS);
}

/** @deprecated Use startAllBrokerScans — library supports one browse type at a time. */
export function startZeroconfScan(serviceType: string) {
  wireEvents();
  activeTypes.add(serviceType);
  if (!scanSessionActive) {
    startAllBrokerScans();
  }
}

export function stopAllZeroconfScans() {
  invalidateScanSession();
  stopNativeScan();
}

export function serviceEntryKey(service: ServiceEntry): string {
  const st = removeLeadingAndTrailingDots(service.type || '');
  return `${service.name || 'unknown'}_${service.domain || 'local'}_${st}`;
}

export function canSoftRefreshDiscovery(): boolean {
  return Platform.OS === 'android' && scanSessionActive;
}
