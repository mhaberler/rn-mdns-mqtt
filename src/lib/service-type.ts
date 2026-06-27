import type { BrokerSource } from '@/types/broker';

const MQTT_WS = '_mqtt-ws._tcp.';
const MQTT_WSS = '_mqtt-wss._tcp.';

export const BROKER_SERVICE_TYPES = [MQTT_WS, MQTT_WSS] as const;

export function removeLeadingAndTrailingDots(str: string): string {
  return str.replace(/^\.+|\.+$/g, '');
}

export function toScanParts(serviceType: string): { type: string; protocol: 'tcp' | 'udp' } {
  const normalized = removeLeadingAndTrailingDots(serviceType);
  const match = normalized.match(/^_(.+)\._tcp$/);
  return { type: match?.[1] ?? normalized, protocol: 'tcp' };
}

export function serviceTypeFromFullName(fullName: string): string | null {
  for (const st of BROKER_SERVICE_TYPES) {
    const bare = st.replace(/\.$/, '');
    if (fullName.includes(bare)) return st;
  }
  return null;
}

export function friendlyType(type: string): string {
  if (type.includes('wss')) return 'WSS';
  if (type.includes('ws')) return 'WS';
  if (type.includes('mqtts')) return 'MQTTS';
  return 'MQTT';
}

export function isWssType(type: string): boolean {
  return type.includes('wss') || type.includes('mqtts');
}

export function brokerKey(service: { host: string; port: number; type: string }): string {
  return `${service.host}:${service.port}:${service.type}`;
}

type ServiceEntryLike = {
  source?: BrokerSource;
  discovered?: boolean;
};

export function sourceOf(service: ServiceEntryLike): BrokerSource {
  if (service.source) return service.source;
  if (service.discovered) return 'discovered';
  return 'preconfigured';
}
