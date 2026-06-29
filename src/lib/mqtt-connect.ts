import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { Platform } from 'react-native';

import { brokerConnectEndpoint } from '@/lib/broker-host';
import { buildConnectUrl, buildBrokerUrl } from '@/lib/mqtt-url';
import {
  isNativeMqttType,
  isTlsType,
  isWebSocketType,
  mqttProtocolForType,
} from '@/lib/service-type';
import type { ServiceEntry } from '@/types/broker';

function mqttClientIdFromTxt(txt?: Record<string, string>): string | undefined {
  if (!txt) return undefined;
  const raw = txt.cid ?? txt.clientId ?? txt.client_id ?? txt.clientid;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

export function createMqttClientId(prefix = 'mqtt_rn'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolveMqttClientId(broker: ServiceEntry, preferred?: string): string {
  const fromPreferred = preferred?.trim();
  if (fromPreferred) return fromPreferred;
  const fromTxt = mqttClientIdFromTxt(broker.txtRecord);
  if (fromTxt) return fromTxt;
  return createMqttClientId();
}

/** iPhone Personal Hotspot: phone is 172.20.10.1, ESP client e.g. 172.20.10.3 — must bind outbound iface. */
function inferIphoneHotspotBind(brokerHost: string): string | undefined {
  const match = brokerHost.match(/^172\.20\.10\.(\d{1,3})$/);
  if (match && match[1] !== '1') return '172.20.10.1';
  return undefined;
}

export function buildConnectOptions(
  broker: ServiceEntry,
  userOpts: IClientOptions,
  deviceIp?: string,
): IClientOptions {
  const endpoint = brokerConnectEndpoint(broker, deviceIp);
  if (!endpoint) {
    throw new Error('Broker host/port not ready');
  }

  const opts: IClientOptions & { interface?: string; localAddress?: string } = {
    ...userOpts,
    protocol: mqttProtocolForType(broker.type),
    host: endpoint.host,
    hostname: endpoint.host,
    port: endpoint.port,
    clientId: resolveMqttClientId(broker, userOpts.clientId),
  };

  if (isWebSocketType(broker.type)) {
    opts.path = broker.txtRecord?.path || '/mqtt';
  }

  if (isTlsType(broker.type)) {
    opts.rejectUnauthorized = broker.rejectUnauthorized !== false;
  }

  // react-native-tcp-socket: localAddress binds outbound iface (iOS viaInterface / Android dual-WiFi).
  if (Platform.OS !== 'web' && isNativeMqttType(broker.type)) {
    const bindAddress = deviceIp ?? inferIphoneHotspotBind(endpoint.host);
    if (bindAddress) {
      opts.localAddress = bindAddress;
    }
    // interface=wifi triggers bindProcessToNetwork; skip when localAddress already pins the iface.
    if (Platform.OS === 'android' && !bindAddress) {
      opts.interface = 'wifi';
    }
  }

  return opts;
}

export function connectLogLabel(
  broker: ServiceEntry,
  opts: IClientOptions,
  deviceIp?: string,
): string {
  const transport = opts.protocol?.startsWith('ws') ? 'ws' : 'tcp';
  const extras =
    broker.ipv4Addresses && broker.ipv4Addresses.length > 1
      ? ` addrs=[${broker.ipv4Addresses.join(',')}]`
      : '';
  const phone = deviceIp ? ` phoneIp=${deviceIp}` : '';
  const bind =
    'localAddress' in opts && opts.localAddress ? ` bind=${opts.localAddress}` : '';
  return `connect to ${broker.name} host=${opts.host} port=${opts.port} proto=${opts.protocol} ${transport} clientId=${opts.clientId}${phone}${bind}${extras}`;
}

export function connectMqttClient(broker: ServiceEntry, options: IClientOptions): MqttClient {
  return mqtt.connect(buildConnectOptions(broker, options));
}

export function friendlyConnectError(message: string, broker: ServiceEntry): string {
  const url = buildConnectUrl(broker);
  if (message.includes('connack timeout')) {
    if (isNativeMqttType(broker.type)) {
      return `Broker did not reply (CONNACK timeout) at ${url}. Check IP/port, same Wi‑Fi, and broker accepts native MQTT.`;
    }
    return `Broker did not reply (CONNACK timeout) at ${url}. Check IP/port, WS path (/mqtt), same Wi‑Fi, and broker is MQTT-over-WebSocket.`;
  }
  return `Connection failed: ${message}`;
}

export function brokerConnectLabel(broker: ServiceEntry): string {
  return buildConnectUrl(broker) || buildBrokerUrl(broker);
}
