import {
  brokerConnectEndpoint,
  formatHostForUrl,
  normalizeMdnsHost,
} from '@/lib/broker-host';
import { isWebSocketType, mqttProtocolForType } from '@/lib/service-type';
import type { ServiceEntry } from '@/types/broker';

export function buildBrokerUrl(broker: ServiceEntry): string {
  const endpoint = brokerConnectEndpoint(broker);
  if (!endpoint) {
    const host = formatHostForUrl(normalizeMdnsHost(broker.host));
    return `ws://${host}:${broker.port || 0}`;
  }
  const host = formatHostForUrl(endpoint.host);
  const protocol = mqttProtocolForType(broker.type);
  return `${protocol}://${host}:${endpoint.port}`;
}

export function buildConnectUrl(broker: ServiceEntry): string {
  const base = buildBrokerUrl(broker);
  if (isWebSocketType(broker.type)) {
    const wsPath = broker.txtRecord?.path || '/mqtt';
    return `${base}${wsPath}`;
  }
  return base;
}
