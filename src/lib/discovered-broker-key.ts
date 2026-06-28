import { serviceEntryKey } from '@/lib/zeroconf-adapter';
import type { DiscoverySegment, ServiceEntry } from '@/types/broker';

export function discoveredBrokerKey(service: ServiceEntry): string {
  const base = serviceEntryKey(service);
  const segment: DiscoverySegment = service.discoverySegment ?? 'upstream';
  return `${base}__${segment}`;
}

export function isHotspotSegment(service: ServiceEntry): boolean {
  return service.discoverySegment === 'hotspot';
}

export function isUpstreamSegment(service: ServiceEntry): boolean {
  return service.discoverySegment !== 'hotspot';
}
