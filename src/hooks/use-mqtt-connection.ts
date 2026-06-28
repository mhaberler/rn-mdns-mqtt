import '@/lib/polyfills';

import mqtt, { type MqttClient } from 'mqtt';

import {
  brokerConnectEndpoint,
  formatHostForUrl,
  isBrokerConnectReady,
  normalizeMdnsHost,
} from '@/lib/broker-host';
import { createExternalStore } from '@/lib/external-store';
import { isWssType } from '@/lib/service-type';
import { liveHostForFromDiscovery } from '@/hooks/use-mqtt-discovery';
import type { ConnectionState, MessageItem, ServiceEntry } from '@/types/broker';

const wsPatterns = ['_mqtt-ws._tcp.', '_mqtt-wss._tcp.', '._mqtt-ws._tcp', '._mqtt-wss._tcp'];
const tlsPatterns = ['_mqtts._tcp.', '_mqtt-wss._tcp.', '._mqtts._tcp.', '._mqtt-wss._tcp.'];

function isWebSocketType(type: string): boolean {
  return wsPatterns.some((p) => type.includes(p));
}

function isTlsType(type: string): boolean {
  return tlsPatterns.some((p) => type.includes(p));
}

export function buildBrokerUrl(broker: ServiceEntry): string {
  const endpoint = brokerConnectEndpoint(broker);
  if (!endpoint) {
    const host = formatHostForUrl(normalizeMdnsHost(broker.host));
    return `ws://${host}:${broker.port || 0}`;
  }
  const isWs = isWebSocketType(broker.type);
  const isTls = isTlsType(broker.type);
  if (isWs) {
    return `${isTls ? 'wss' : 'ws'}://${endpoint.host}:${endpoint.port}`;
  }
  return `${isTls ? 'mqtts' : 'mqtt'}://${endpoint.host}:${endpoint.port}`;
}

export function buildConnectUrl(broker: ServiceEntry): string {
  const base = buildBrokerUrl(broker);
  if (isWebSocketType(broker.type)) {
    const wsPath = broker.txtRecord?.path || '/mqtt';
    return `${base}${wsPath}`;
  }
  return base;
}

function derivedSource(broker: ServiceEntry): string {
  if (broker.source) return broker.source;
  if (broker.discovered) return 'discovered';
  return 'preconfigured';
}

function withLiveHost(broker: ServiceEntry): ServiceEntry {
  if (derivedSource(broker) !== 'discovered') return broker;
  const live = liveHostForFromDiscovery(broker.name, broker.type);
  if (!live) return broker;
  return {
    ...broker,
    host: live.host,
    port: live.port,
    ipv4Addresses: live.ipv4Addresses ?? broker.ipv4Addresses,
    ipv6Addresses: live.ipv6Addresses ?? broker.ipv6Addresses,
  };
}

const connectionStateStore = createExternalStore<ConnectionState>('disconnected');
const errorStore = createExternalStore<string | null>(null);
const messagesStore = createExternalStore<MessageItem[]>([]);
const connectedBrokerStore = createExternalStore<ServiceEntry | null>(null);

let mqttClient: MqttClient | null = null;
let connectionTimeout: ReturnType<typeof setTimeout> | null = null;

const MESSAGE_CAP = 10;

function addMessage(topic: string, payload: string) {
  const timestamp = new Date().toLocaleTimeString();
  const newMsg: MessageItem = {
    id: `${timestamp}-${Math.random().toString(16).slice(2, 10)}`,
    topic,
    payload,
    timestamp,
  };
  messagesStore.setState((current) => [newMsg, ...current].slice(0, MESSAGE_CAP));
}

function cleanup() {
  if (connectionTimeout) {
    clearTimeout(connectionTimeout);
    connectionTimeout = null;
  }
  if (mqttClient) {
    try {
      mqttClient.removeAllListeners();
      mqttClient.end(true);
    } catch {
      /* ignore */
    }
    mqttClient = null;
  }
}

function friendlyConnectError(message: string, url: string): string {
  if (message.includes('connack timeout')) {
    return `Broker did not reply (CONNACK timeout) at ${url}. Check IP/port, WS path (/mqtt), same Wi‑Fi, and broker is MQTT-over-WebSocket.`;
  }
  return `Connection failed: ${message}`;
}

function connect(brokerArg: ServiceEntry) {
  const broker = withLiveHost(brokerArg);

  if (
    mqttClient &&
    connectionStateStore.getState() === 'connected' &&
    connectedBrokerStore.getState()?.host === broker.host &&
    connectedBrokerStore.getState()?.port === broker.port &&
    connectedBrokerStore.getState()?.type === broker.type
  ) {
    return;
  }

  cleanup();

  connectionStateStore.setState('trying');
  errorStore.setState(null);
  connectedBrokerStore.setState(broker);

  if (!isBrokerConnectReady(broker)) {
    errorStore.setState('Broker not resolved yet — wait for green dot or tap Refresh');
    connectionStateStore.setState('disconnected');
    connectedBrokerStore.setState(null);
    return;
  }

  try {
    const url = buildConnectUrl(broker);

    const options: mqtt.IClientOptions = {
      clientId: `mqtt_rn_${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      connectTimeout: 30000,
      reconnectPeriod: 0,
    };

    if (broker.username) options.username = broker.username;
    if (broker.password) options.password = broker.password;

    if (isTlsType(broker.type)) {
      options.rejectUnauthorized = broker.rejectUnauthorized !== false;
    }

    mqttClient = mqtt.connect(url, options);

    mqttClient.on('connect', () => {
      connectionStateStore.setState('connected');
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }

      mqttClient?.subscribe('#', (err) => {
        if (err) {
          errorStore.setState(`Failed to subscribe: ${err.message}`);
        } else {
          addMessage('system', 'Connected and subscribed to all topics (#)');
        }
      });
    });

    mqttClient.on('error', (err: Error) => {
      errorStore.setState(friendlyConnectError(err?.message || 'Unknown error', url));
      connectionStateStore.setState('disconnected');
      cleanup();
    });

    mqttClient.on('close', () => {
      const wasTrying = connectionStateStore.getState() === 'trying';
      const wasConnected = connectionStateStore.getState() === 'connected';
      connectionStateStore.setState('disconnected');
      if (wasTrying) {
        errorStore.setState(
          (current) => current ?? `Connection closed before CONNACK at ${url}`,
        );
      } else if (wasConnected) {
        addMessage('system', 'Connection closed');
      }
    });

    mqttClient.on('message', (topic: string, message: Buffer) => {
      let payload: string;
      try {
        const messageStr = message.toString();
        const parsed = JSON.parse(messageStr) as unknown;
        payload = JSON.stringify(parsed, null, 2);
      } catch {
        payload = message.toString();
      }
      addMessage(topic, payload);
    });

    connectionTimeout = setTimeout(() => {
      if (connectionStateStore.getState() === 'trying') {
        errorStore.setState('Connection timeout — check broker address and port');
        connectionStateStore.setState('disconnected');
        cleanup();
      }
    }, 15000);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    errorStore.setState(`Connection failed: ${msg}`);
    connectionStateStore.setState('disconnected');
    connectedBrokerStore.setState(null);
  }
}

function disconnect() {
  cleanup();
  connectionStateStore.setState('disconnected');
  connectedBrokerStore.setState(null);
  addMessage('system', 'Disconnected from broker');
}

function publish(topic: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!mqttClient || connectionStateStore.getState() !== 'connected') {
      reject(new Error('Not connected'));
      return;
    }
    mqttClient.publish(topic, payload, (err?: Error) => {
      if (err) {
        errorStore.setState(`Failed to publish: ${err.message}`);
        reject(err);
      } else {
        addMessage('system', `Published to ${topic}: ${payload}`);
        resolve();
      }
    });
  });
}

async function testConnect(broker: ServiceEntry, timeoutMs: number = 15000): Promise<boolean> {
  if (!isBrokerConnectReady(broker)) return false;

  const url = buildConnectUrl(broker);
  const testTopic = `__test/${Math.random().toString(16).slice(2, 10)}`;
  const testPayload = `test-${Date.now()}`;

  const options: mqtt.IClientOptions = {
    clientId: `mqtt_test_${Math.random().toString(16).slice(2, 10)}`,
    clean: true,
    connectTimeout: timeoutMs,
    reconnectPeriod: 0,
  };

  if (broker.username) options.username = broker.username;
  if (broker.password) options.password = broker.password;
  if (isTlsType(broker.type)) {
    options.rejectUnauthorized = broker.rejectUnauthorized !== false;
  }

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const testClient = mqtt.connect(url, options);

    const finish = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      try {
        testClient.removeAllListeners();
        testClient.end(true);
      } catch {
        /* ignore */
      }
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    testClient.on('connect', () => {
      testClient.subscribe(testTopic, (err) => {
        if (err) {
          finish(false);
          return;
        }
        testClient.publish(testTopic, testPayload);
      });
    });

    testClient.on('message', (topic: string, message: Buffer) => {
      if (topic === testTopic && message.toString() === testPayload) {
        finish(true);
      }
    });

    testClient.on('error', () => finish(false));
    testClient.on('close', () => finish(false));
  });
}

export function useMqttConnection() {
  const connectionState = connectionStateStore.useStore();
  const error = errorStore.useStore();
  const messages = messagesStore.useStore();
  const connectedBroker = connectedBrokerStore.useStore();

  return {
    connectionState,
    error,
    messages,
    connectedBroker,
    brokerUrl: connectedBroker ? buildConnectUrl(connectedBroker) : '',
    isConnected: connectionState === 'connected',
    isTrying: connectionState === 'trying',
    connect,
    disconnect,
    publish,
    testConnect,
    clearMessages: () => messagesStore.setState([]),
    addMessage,
    setError: (value: string | null) => errorStore.setState(value),
  };
}
