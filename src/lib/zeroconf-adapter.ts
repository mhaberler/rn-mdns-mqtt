import Zeroconf, { type Service } from 'react-native-zeroconf';

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

const ANDROID_IMPL = 'DNSSD';
const DOMAIN = 'local.';
/** react-native-zeroconf allows one browse type at a time; rotate so slow LAN devices still appear. */
const SCAN_SLICE_MS = 8_000;

let zeroconf: Zeroconf | null = null;
const activeTypes = new Set<string>();
const listeners = new Set<DiscoveryListener>();
const knownServiceTypes = new Map<string, string>();
let wired = false;
let rotationTimer: ReturnType<typeof setInterval> | null = null;
let rotationIndex = 0;
let currentScanType: (typeof BROKER_SERVICE_TYPES)[number] | null = null;

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

  return {
    name: service.name || `${type} Service`,
    type,
    host,
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

function rememberServiceType(name: string, type: string) {
  knownServiceTypes.set(name, type);
}

function emit(event: ZeroconfDiscoveryEvent) {
  listeners.forEach((listener) => listener(event));
}

function scanServiceType(serviceType: (typeof BROKER_SERVICE_TYPES)[number]) {
  const z = getZeroconf();
  if (!z) return;

  currentScanType = serviceType;
  const { type, protocol } = toScanParts(serviceType);
  z.scan(type, protocol, DOMAIN, ANDROID_IMPL);
}

function rotateScan() {
  const types = BROKER_SERVICE_TYPES.filter((t) => activeTypes.has(t));
  if (types.length === 0) return;

  rotationIndex = (rotationIndex + 1) % types.length;
  scanServiceType(types[rotationIndex]);
}

function wireEvents() {
  if (wired) return;
  const z = getZeroconf();
  if (!z) return;
  wired = true;

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
  if (!hasDevClientNativeModules()) return;
  wireEvents();
  if (rotationTimer) return;

  activeTypes.clear();
  for (const serviceType of BROKER_SERVICE_TYPES) {
    activeTypes.add(serviceType);
  }

  rotationIndex = 0;
  scanServiceType(BROKER_SERVICE_TYPES[0]);
  rotationTimer = setInterval(rotateScan, SCAN_SLICE_MS);
}

/** @deprecated Use startAllBrokerScans — library supports one browse type at a time. */
export function startZeroconfScan(serviceType: string) {
  if (!hasDevClientNativeModules()) return;
  wireEvents();
  activeTypes.add(serviceType);
  if (!rotationTimer) {
    startAllBrokerScans();
  }
}

export function stopAllZeroconfScans() {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
  activeTypes.clear();
  knownServiceTypes.clear();
  currentScanType = null;
  rotationIndex = 0;

  if (!hasDevClientNativeModules() || !zeroconf) return;
  zeroconf.stop(ANDROID_IMPL);
}

export function serviceEntryKey(service: ServiceEntry): string {
  const st = removeLeadingAndTrailingDots(service.type || '');
  return `${service.name || 'unknown'}_${service.domain || 'local'}_${st}`;
}
