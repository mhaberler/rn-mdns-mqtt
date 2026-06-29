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
  type BrokerServiceType,
} from '@/lib/service-type';

export type ZeroconfDiscoveryAction = 'added' | 'removed' | 'resolved';

export type ZeroconfDiscoveryEvent = {
  action: ZeroconfDiscoveryAction;
  service: ServiceEntry;
};

type DiscoveryListener = (event: ZeroconfDiscoveryEvent) => void;

const DOMAIN = 'local.';
const PLATFORM_SCAN_TYPES: readonly BrokerServiceType[] = BROKER_SERVICE_TYPES;
const ROTATE_SCAN_TYPES = Platform.OS === 'ios' && PLATFORM_SCAN_TYPES.length > 1;
const INITIAL_WS_SLICE_MS = 15_000;
const SCAN_SLICE_MS = 8_000;
const USE_ANDROID_NSD = Platform.OS === 'android';

type NsdServiceEvent = {
  action: 'added' | 'resolved' | 'removed';
  service: {
    domain: string;
    type: string;
    name: string;
    port: number;
    hostname: string;
    ipv4Addresses: string[];
    ipv6Addresses: string[];
    txtRecord?: Record<string, string>;
  };
};

type NsdModule = {
  watchAll(types: string[], domain: string): Promise<void>;
  unwatchAll(types: string[], domain: string): Promise<void>;
  closeDiscovery(): Promise<void>;
  addServiceListener(listener: (event: NsdServiceEvent) => void): { remove: () => void };
};

let nsdModule: NsdModule | null = null;

function getNsdModule(): NsdModule {
  if (!nsdModule) {
    nsdModule = require('zeroconf-nsd') as NsdModule;
  }
  return nsdModule;
}

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
let androidServiceSubscription: { remove: () => void } | null = null;

function getZeroconf(): Zeroconf | null {
  if (!hasDevClientNativeModules() || USE_ANDROID_NSD) return null;
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

function mapServiceEntry(
  input: {
    name?: string;
    type?: string;
    host?: string;
    port?: number;
    domain?: string;
    txtRecord?: Record<string, string>;
    ipv4Addresses?: string[];
    ipv6Addresses?: string[];
    addresses?: string[];
  },
  action: ZeroconfDiscoveryAction,
  fallbackType?: string,
): ServiceEntry | null {
  const type =
    fallbackType ??
    (input.type && input.type.includes('._tcp') ? input.type : null) ??
    serviceTypeFromFullName(input.name ?? '') ??
    BROKER_SERVICE_TYPES[0];
  const host =
    input.host ||
    input.ipv4Addresses?.[0] ||
    input.ipv6Addresses?.[0] ||
    input.addresses?.[0] ||
    'Unknown';
  const ipv4 = input.ipv4Addresses ?? splitAddresses(input.addresses).ipv4;
  const ipv6 = input.ipv6Addresses ?? splitAddresses(input.addresses).ipv6;
  const port = input.port ?? 0;
  const connectHost = pickConnectHost({ host, ipv4Addresses: ipv4, ipv6Addresses: ipv6 });

  return {
    name: input.name || `${type} Service`,
    type,
    host: connectHost,
    port: port > 0 ? port : 0,
    domain: input.domain?.replace(/\.$/, '') || 'local',
    discovered: true,
    resolved: action === 'resolved' && port > 0,
    source: 'discovered',
    txtRecord: input.txtRecord ?? {},
    ipv4Addresses: ipv4,
    ipv6Addresses: ipv6,
  };
}

function mapIosService(
  service: Service,
  action: ZeroconfDiscoveryAction,
  fallbackType?: string,
): ServiceEntry | null {
  return mapServiceEntry(
    {
      name: service.name,
      type: fallbackType,
      host: service.host,
      port: service.port,
      txtRecord: service.txt,
      addresses: service.addresses,
    },
    action,
    fallbackType,
  );
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

async function stopNativeScan(): Promise<void> {
  if (!hasDevClientNativeModules()) return;

  if (USE_ANDROID_NSD) {
    await stopAndroidScans();
    return;
  }

  if (!zeroconf) return;
  try {
    zeroconf.stop();
  } catch {
    /* stop while native browse is tearing down */
  }
}

async function stopAndroidScans() {
  const nsd = getNsdModule();
  try {
    await nsd.unwatchAll([...PLATFORM_SCAN_TYPES], DOMAIN);
  } catch {
    /* ignore unwatch while tearing down */
  }
  try {
    await nsd.closeDiscovery();
  } catch {
    /* ignore close while tearing down */
  }
  androidServiceSubscription?.remove();
  androidServiceSubscription = null;
}

function scanServiceType(serviceType: BrokerServiceType) {
  const z = getZeroconf();
  if (!z) return;

  currentScanType = serviceType;
  const { type, protocol } = toScanParts(serviceType);
  try {
    z.scan(type, protocol, DOMAIN);
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
    const mapped = mapIosService(raw, 'resolved', fallbackType);
    if (!mapped || mapped.port <= 0) continue;
    rememberServiceType(mapped.name, mapped.type);
    emit({ action: 'resolved', service: mapped });
  }
}

function wireAndroidEvents() {
  if (androidServiceSubscription) return;

  androidServiceSubscription = getNsdModule().addServiceListener(({ action, service }) => {
    const mapped = mapServiceEntry(
      {
        name: service.name,
        type: service.type,
        host: service.hostname,
        port: service.port,
        domain: service.domain,
        txtRecord: service.txtRecord,
        ipv4Addresses: service.ipv4Addresses,
        ipv6Addresses: service.ipv6Addresses,
      },
      action,
      service.type,
    );
    if (!mapped) return;
    rememberServiceType(mapped.name, mapped.type);
    emit({ action, service: mapped });
  });
}

async function startAndroidScans() {
  wireAndroidEvents();
  await getNsdModule().watchAll([...PLATFORM_SCAN_TYPES], DOMAIN);
}

async function armScanSession(): Promise<void> {
  if (!hasDevClientNativeModules()) return;

  if (USE_ANDROID_NSD) {
    scanSessionActive = true;
    try {
      await startAndroidScans();
    } catch (err) {
      console.warn('[zeroconf-nsd]', err);
      scanSessionActive = false;
    }
    return;
  }

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

function wireIosEvents() {
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
    const mapped = mapIosService(raw, 'added', currentScanType ?? undefined);
    if (!mapped) return;
    rememberServiceType(mapped.name, mapped.type);
    emit({ action: 'added', service: mapped });
  });

  z.on('resolved', (service: Service) => {
    const mapped = mapIosService(service, 'resolved', currentScanType ?? undefined);
    if (!mapped) return;
    rememberServiceType(mapped.name, mapped.type);
    emit({ action: 'resolved', service: mapped });
  });

  z.on('remove', (name: string) => {
    const raw = z.getServices()[name];
    const fallbackType =
      knownServiceTypes.get(name) ?? currentScanType ?? BROKER_SERVICE_TYPES[0];
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

    const mapped = mapIosService(raw, 'removed', fallbackType);
    if (mapped) emit({ action: 'removed', service: mapped });
  });
}

function wireEvents() {
  if (USE_ANDROID_NSD) {
    wireAndroidEvents();
    return;
  }
  wireIosEvents();
}

export function subscribeZeroconf(listener: DiscoveryListener): () => void {
  wireEvents();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startAllBrokerScans() {
  wireEvents();
  if (scanSessionActive) return;
  void armScanSession();
}

export async function startAllBrokerScansAsync() {
  wireEvents();
  if (scanSessionActive) return;
  await armScanSession();
}

export function softRefreshBrokerDiscovery() {
  if (USE_ANDROID_NSD) return;
  wireEvents();
  republishCachedServices();
}

export async function restartAllBrokerScans() {
  wireEvents();
  invalidateScanSession();
  await stopNativeScan();
  await armScanSession();
}

export async function stopAllZeroconfScans() {
  invalidateScanSession();
  await stopNativeScan();
}

export function serviceEntryKey(service: ServiceEntry): string {
  const st = removeLeadingAndTrailingDots(service.type || '');
  return `${service.name || 'unknown'}_${service.domain || 'local'}_${st}`;
}

export function canSoftRefreshDiscovery(): boolean {
  return !USE_ANDROID_NSD && scanSessionActive;
}

/** @deprecated Use startAllBrokerScans */
export function startZeroconfScan(serviceType: string) {
  wireEvents();
  activeTypes.add(serviceType);
  if (!scanSessionActive) {
    startAllBrokerScans();
  }
}
