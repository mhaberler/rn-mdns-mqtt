import { Platform } from 'react-native';
import Zeroconf, { type Service } from 'react-native-zeroconf';

import type { ServiceEntry } from '@/types/broker';
import { removeLeadingAndTrailingDots, serviceTypeFromFullName, toScanParts } from '@/lib/service-type';

export type ZeroconfDiscoveryAction = 'added' | 'removed' | 'resolved';

export type ZeroconfDiscoveryEvent = {
  action: ZeroconfDiscoveryAction;
  service: ServiceEntry;
};

type DiscoveryListener = (event: ZeroconfDiscoveryEvent) => void;

const ANDROID_IMPL = 'DNSSD';
const DOMAIN = 'local.';

let zeroconf: Zeroconf | null = null;
const activeTypes = new Set<string>();
const listeners = new Set<DiscoveryListener>();
let wired = false;

function getZeroconf(): Zeroconf {
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

function mapService(service: Service, action: ZeroconfDiscoveryAction, fallbackType?: string): ServiceEntry | null {
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

function emit(event: ZeroconfDiscoveryEvent) {
  listeners.forEach((listener) => listener(event));
}

function wireEvents() {
  if (wired) return;
  wired = true;

  const z = getZeroconf();

  z.on('found', (name: string) => {
    const services = z.getServices();
    const raw = services[name];
    if (!raw) return;
    const mapped = mapService(raw, 'added');
    if (mapped) emit({ action: 'added', service: mapped });
  });

  z.on('resolved', (service: Service) => {
    const mapped = mapService(service, 'resolved');
    if (mapped) emit({ action: 'resolved', service: mapped });
  });

  z.on('remove', (name: string) => {
    const services = z.getServices();
    const raw = services[name];
    if (!raw) {
      emit({
        action: 'removed',
        service: {
          name,
          type: '_mqtt-ws._tcp.',
          host: 'Unknown',
          port: 0,
          discovered: true,
          resolved: false,
          source: 'discovered',
        },
      });
      return;
    }
    const mapped = mapService(raw, 'removed');
    if (mapped) emit({ action: 'removed', service: mapped });
  });
}

export function subscribeZeroconf(listener: DiscoveryListener): () => void {
  wireEvents();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startZeroconfScan(serviceType: string) {
  if (Platform.OS === 'web') return;
  wireEvents();
  if (activeTypes.has(serviceType)) return;

  activeTypes.add(serviceType);
  const { type, protocol } = toScanParts(serviceType);
  getZeroconf().scan(type, protocol, DOMAIN, ANDROID_IMPL);
}

export function stopZeroconfScan(serviceType: string) {
  if (Platform.OS === 'web' || !zeroconf) return;
  if (!activeTypes.has(serviceType)) return;

  activeTypes.delete(serviceType);
  const { type, protocol } = toScanParts(serviceType);
  zeroconf.stop(ANDROID_IMPL);

  if (activeTypes.size > 0) {
    for (const active of activeTypes) {
      const parts = toScanParts(active);
      zeroconf.scan(parts.type, parts.protocol, DOMAIN, ANDROID_IMPL);
    }
  }
}

export function stopAllZeroconfScans() {
  if (Platform.OS === 'web' || !zeroconf) return;
  activeTypes.clear();
  zeroconf.stop(ANDROID_IMPL);
}

export function serviceEntryKey(service: ServiceEntry): string {
  const st = removeLeadingAndTrailingDots(service.type || '');
  return `${service.name || 'unknown'}_${service.domain || 'local'}_${st}`;
}
