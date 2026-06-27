import '@/lib/polyfills';

import mqtt, { type MqttClient } from 'mqtt';

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
  const isWs = isWebSocketType(broker.type);
  const isTls = isTlsType(broker.type);
  if (isWs) {
    return `${isTls ? 'wss' : 'ws'}://${broker.host}:${broker.port}`;
  }
  return `${isTls ? 'mqtts' : 'mqtt'}://${broker.host}:${broker.port}`;
}

function buildConnectUrl(broker: ServiceEntry): string {
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
  return { ...broker, host: live.host, port: live.port };
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

  try {
    const url = buildConnectUrl(broker);

    const options: mqtt.IClientOptions = {
      clientId: `mqtt_rn_${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      connectTimeout: 30000,
      reconnectPeriod: 3000,
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
      errorStore.setState(`Connection failed: ${err?.message || 'Unknown error'}`);
      connectionStateStore.setState('disconnected');
    });

    mqttClient.on('close', () => {
      connectionStateStore.setState('disconnected');
      addMessage('system', 'Connection closed');
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
    brokerUrl: connectedBroker ? buildBrokerUrl(connectedBroker) : '',
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
