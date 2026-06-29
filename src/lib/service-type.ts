import type { BrokerSource } from '@/types/broker';

const MQTT_WS = '_mqtt-ws._tcp.';
const MQTT_WSS = '_mqtt-wss._tcp.';
const MQTT_TCP = '_mqtt._tcp.';
const SECURE_MQTT_TCP = '_secure-mqtt._tcp.';

export const BROKER_SERVICE_TYPES = [MQTT_WS, MQTT_WSS, MQTT_TCP, SECURE_MQTT_TCP] as const;

export type BrokerServiceType = (typeof BROKER_SERVICE_TYPES)[number];

export const DEFAULT_PORT_BY_SERVICE_TYPE: Record<BrokerServiceType, number> = {
  [MQTT_WS]: 8080,
  [MQTT_WSS]: 8081,
  [MQTT_TCP]: 1883,
  [SECURE_MQTT_TCP]: 8883,
};

const WS_PATTERNS = ['_mqtt-ws._tcp.', '_mqtt-wss._tcp.', '._mqtt-ws._tcp', '._mqtt-wss._tcp'];
const TLS_PATTERNS = [
  '_mqtt-wss._tcp.',
  '_secure-mqtt._tcp.',
  '._mqtt-wss._tcp',
  '._secure-mqtt._tcp',
  '_mqtts._tcp.',
  '._mqtts._tcp.',
];
const NATIVE_MQTT_PATTERNS = ['_mqtt._tcp.', '_secure-mqtt._tcp.', '._mqtt._tcp', '._secure-mqtt._tcp'];

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

export function isWebSocketType(type: string): boolean {
  return WS_PATTERNS.some((p) => type.includes(p));
}

export function isNativeMqttType(type: string): boolean {
  return NATIVE_MQTT_PATTERNS.some((p) => type.includes(p));
}

export function isTlsType(type: string): boolean {
  return TLS_PATTERNS.some((p) => type.includes(p));
}

export type MqttConnectProtocol = 'ws' | 'wss' | 'mqtt' | 'mqtts';

export function mqttProtocolForType(type: string): MqttConnectProtocol {
  if (type.includes('mqtt-wss')) return 'wss';
  if (type.includes('mqtt-ws')) return 'ws';
  if (type.includes('secure-mqtt') || type.includes('mqtts._tcp')) return 'mqtts';
  return 'mqtt';
}

/** Warn when manual port/type combo would send WebSocket handshake to native MQTT (or vice versa). */
export function validateBrokerTypePort(type: string, port: number): string | null {
  if (port === 1883 && isWebSocketType(type)) {
    return 'Port 1883 is native MQTT — use MQTT type, not WS/WSS';
  }
  if (port === 8883 && isWebSocketType(type)) {
    return 'Port 8883 is MQTTS — use MQTTS type, not WS/WSS';
  }
  if (port === 8080 && isNativeMqttType(type)) {
    return 'Port 8080 is MQTT-over-WebSocket — use WS type, not MQTT/MQTTS';
  }
  if (port === 8081 && isNativeMqttType(type)) {
    return 'Port 8081 is MQTTS-over-WebSocket — use WSS type, not MQTT/MQTTS';
  }
  return null;
}

export function serviceTypeForPort(port: number): BrokerServiceType | undefined {
  for (const st of BROKER_SERVICE_TYPES) {
    if (DEFAULT_PORT_BY_SERVICE_TYPE[st] === port) return st;
  }
  return undefined;
}

/** @deprecated Use isTlsType for WSS and MQTTS */
export function isWssType(type: string): boolean {
  return isTlsType(type) && isWebSocketType(type);
}

export function friendlyType(type: string): string {
  if (type.includes('mqtt-wss')) return 'WSS';
  if (type.includes('mqtt-ws')) return 'WS';
  if (type.includes('secure-mqtt') || type.includes('mqtts._tcp')) return 'MQTTS';
  if (type.includes('_mqtt._tcp')) return 'MQTT';
  return 'MQTT';
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
