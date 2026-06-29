import { serviceEntryKey } from '@/lib/zeroconf-adapter';
import type { ServiceEntry } from '@/types/broker';

export function discoveredBrokerKey(service: ServiceEntry): string {
  return serviceEntryKey(service);
}
