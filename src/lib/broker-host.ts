import type { ServiceEntry } from '@/types/broker';

/** Strip mDNS trailing dot and reject Android DNSSD placeholder host (= service display name). */
export function normalizeMdnsHost(host: string | undefined): string {
  const trimmed = (host ?? '').trim().replace(/\.$/, '');
  if (!trimmed || trimmed === 'Unknown') return 'Unknown';
  if (trimmed.includes(' ')) return 'Unknown';
  return trimmed;
}

function ipv4Subnet24(ip: string): string | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

function uniqueIps(ips: string[] | undefined): string[] {
  return [...new Set((ips ?? []).map((ip) => ip.trim()).filter(Boolean))];
}

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function onSameSubnet24(a: string, b: string): boolean {
  const subnetA = ipv4Subnet24(a);
  const subnetB = ipv4Subnet24(b);
  return !!subnetA && subnetA === subnetB;
}

/** iPhone Personal Hotspot (172.20.10.x) or ESP SoftAP (192.168.4.x) when phoneIp unavailable. */
function preferHotspotBrokerIp(ips: string[]): string | undefined {
  const iphoneHotspot = ips.find((ip) => ip.startsWith('172.20.10.'));
  if (iphoneHotspot) return iphoneHotspot;
  const espAp = ips.find((ip) => ip.startsWith('192.168.4.'));
  if (espAp) return espAp;
  return undefined;
}

/**
 * Pick broker IPv4 on same /24 as phone when multiple mDNS addresses exist
 * (iPhone hotspot 172.20.10.x, ESP SoftAP 192.168.4.x, vs upstream STA).
 */
export function pickConnectHost(
  entry: {
    host?: string;
    ipv4Addresses?: string[];
    ipv6Addresses?: string[];
  },
  deviceIp?: string,
): string {
  const ipv4List = uniqueIps(entry.ipv4Addresses);

  if (deviceIp) {
    const onSubnet = ipv4List.find((ip) => onSameSubnet24(ip, deviceIp));
    if (onSubnet) return onSubnet;

    const fromHost = normalizeMdnsHost(entry.host);
    if (fromHost !== 'Unknown' && isIpv4Literal(fromHost) && onSameSubnet24(fromHost, deviceIp)) {
      return fromHost;
    }

    // iOS rotation can leave upstream IP while phone is on hotspot — skip wrong subnet.
    if (ipv4List.length > 0 || (fromHost !== 'Unknown' && isIpv4Literal(fromHost))) {
      return 'Unknown';
    }
  }

  if (ipv4List.length > 0) {
    const hotspotIp = preferHotspotBrokerIp(ipv4List);
    if (hotspotIp) return hotspotIp;
  }

  const ipv4 = ipv4List[0];
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

export function brokerConnectEndpoint(
  broker: ServiceEntry,
  deviceIp?: string,
): { host: string; port: number } | null {
  const host = pickConnectHost(broker, deviceIp);
  if (host === 'Unknown' || broker.port <= 0) return null;
  return { host, port: broker.port };
}

export function isBrokerConnectReady(broker: ServiceEntry): boolean {
  return brokerConnectEndpoint(broker) !== null;
}

export function mergeAddressLists(existing?: string[], incoming?: string[]): string[] {
  return uniqueIps([...(existing ?? []), ...(incoming ?? [])]);
}
