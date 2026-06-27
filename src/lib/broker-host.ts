import type { ServiceEntry } from '@/types/broker';

/** Strip mDNS trailing dot and reject Android DNSSD placeholder host (= service display name). */
export function normalizeMdnsHost(host: string | undefined): string {
  const trimmed = (host ?? '').trim().replace(/\.$/, '');
  if (!trimmed || trimmed === 'Unknown') return 'Unknown';
  if (trimmed.includes(' ')) return 'Unknown';
  return trimmed;
}

export function pickConnectHost(entry: {
  host?: string;
  ipv4Addresses?: string[];
  ipv6Addresses?: string[];
}): string {
  const ipv4 = entry.ipv4Addresses?.find(Boolean);
  if (ipv4) return ipv4;

  const fromHost = normalizeMdnsHost(entry.host);
  if (fromHost !== 'Unknown') return fromHost;

  const ipv6 = entry.ipv6Addresses?.find(Boolean);
  if (ipv6) return ipv6;

  return 'Unknown';
}

/** Bracket IPv6 literals for URL authority (ws://[fe80::1]:8883). */
export function formatHostForUrl(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }
  return host;
}

export function brokerConnectEndpoint(broker: ServiceEntry): { host: string; port: number } | null {
  const host = pickConnectHost(broker);
  if (host === 'Unknown' || broker.port <= 0) return null;
  return { host: formatHostForUrl(host), port: broker.port };
}

export function isBrokerConnectReady(broker: ServiceEntry): boolean {
  return brokerConnectEndpoint(broker) !== null;
}
