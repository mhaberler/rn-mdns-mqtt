import { Platform } from 'react-native';

import { mergeAddressLists, normalizeMdnsHost } from '@/lib/broker-host';
import { isNativeMqttType } from '@/lib/service-type';
import type { ServiceEntry } from '@/types/broker';

const RESOLVE_TIMEOUT_MS = 4000;

/**
 * iOS: react-native-tcp-socket resolves via blocking getaddrinfo (waits for both
 * A and AAAA mDNS answers — embedded brokers never answer AAAA, costing ~5s).
 * Pre-resolve .local to IPv4 with a single A query so TCP connects by literal.
 * WebSocket (NSURLSession Happy Eyeballs) is already fast — untouched.
 */
export async function withResolvedLocalHost(broker: ServiceEntry): Promise<ServiceEntry> {
  if (Platform.OS !== 'ios' || !isNativeMqttType(broker.type)) return broker;
  if ((broker.ipv4Addresses?.length ?? 0) > 0) return broker;

  const host = normalizeMdnsHost(broker.host);
  if (host === 'Unknown' || !host.toLowerCase().endsWith('.local')) return broker;

  try {
    const { resolveHostname } = require('zeroconf-nsd') as typeof import('zeroconf-nsd');
    const addresses = await Promise.race([
      resolveHostname(host),
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), RESOLVE_TIMEOUT_MS)),
    ]);
    if (addresses.length === 0) return broker;
    return { ...broker, ipv4Addresses: mergeAddressLists(broker.ipv4Addresses, addresses) };
  } catch {
    return broker;
  }
}
