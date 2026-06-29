import '@/lib/polyfills';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import {
  brokerConnectEndpoint,
  isBrokerConnectReady,
} from '@/lib/broker-host';
import { getDeviceIPv4 } from '@/lib/device-network';
import { createExternalStore } from '@/lib/external-store';
import { buildConnectOptions, connectLogLabel, createMqttClientId, friendlyConnectError } from '@/lib/mqtt-connect';
import { buildConnectUrl } from '@/lib/mqtt-url';
import { validateBrokerTypePort } from '@/lib/service-type';
import { liveHostForFromDiscovery } from '@/hooks/use-mqtt-discovery';
import type { ConnectionState, MessageItem, ServiceEntry } from '@/types/broker';

export { buildBrokerUrl, buildConnectUrl } from '@/lib/mqtt-url';

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
let connectGeneration = 0;
let testConnectInFlight = false;

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

function mqttOptions(broker: ServiceEntry, connectTimeout: number) {
  const options: IClientOptions = {
    clientId: createMqttClientId(),
    clean: true,
    connectTimeout,
    reconnectPeriod: 0,
    protocolId: 'MQTT',
    protocolVersion: 4,
  };

  if (broker.username) options.username = broker.username;
  if (broker.password) options.password = broker.password;

  return options;
}

function selectBroker(broker: ServiceEntry) {
  connectedBrokerStore.setState(broker);
}

function connect(brokerArg: ServiceEntry) {
  const broker = withLiveHost(brokerArg);

  if (testConnectInFlight) {
    errorStore.setState('Connection test in progress — wait for it to finish');
    return;
  }

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

  const generation = ++connectGeneration;
  connectionStateStore.setState('trying');
  errorStore.setState(null);
  connectedBrokerStore.setState(broker);

  if (!isBrokerConnectReady(broker)) {
    errorStore.setState('Broker not resolved yet — wait for green dot or tap Refresh');
    connectionStateStore.setState('disconnected');
    connectedBrokerStore.setState(null);
    return;
  }

  void (async () => {
    try {
      const deviceIp = await getDeviceIPv4();
      if (generation !== connectGeneration) return;

      const endpoint = brokerConnectEndpoint(broker, deviceIp);
      if (!endpoint) {
        errorStore.setState(
          deviceIp
            ? `No broker IP on your subnet (phone ${deviceIp}) — wait for mDNS or tap Refresh`
            : 'Broker not resolved yet — wait for green dot or tap Refresh',
        );
        connectionStateStore.setState('disconnected');
        return;
      }

      const typePortError = validateBrokerTypePort(broker.type, endpoint.port);
      if (typePortError) {
        errorStore.setState(typePortError);
        connectionStateStore.setState('disconnected');
        return;
      }

      const options = mqttOptions(broker, 30000);
      const connectOpts = buildConnectOptions(broker, options, deviceIp);
      if (__DEV__) {
        console.log(connectLogLabel(broker, connectOpts, deviceIp));
      }
      addMessage('system', connectLogLabel(broker, connectOpts, deviceIp));
      mqttClient = mqtt.connect(connectOpts);

    mqttClient.on('connect', () => {
      if (generation !== connectGeneration) return;
      connectionStateStore.setState('connected');
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }

      mqttClient?.subscribe('#', (err) => {
        if (generation !== connectGeneration) return;
        if (err) {
          errorStore.setState(`Failed to subscribe: ${err.message}`);
        } else {
          addMessage('system', 'Connected and subscribed to all topics (#)');
        }
      });
    });

    mqttClient.on('error', (err: Error) => {
      if (generation !== connectGeneration) return;
      errorStore.setState(friendlyConnectError(err?.message || 'Unknown error', broker));
      connectionStateStore.setState('disconnected');
      cleanup();
    });

    mqttClient.on('close', () => {
      if (generation !== connectGeneration) return;
      const wasTrying = connectionStateStore.getState() === 'trying';
      const wasConnected = connectionStateStore.getState() === 'connected';
      connectionStateStore.setState('disconnected');
      if (wasTrying) {
        const endpoint = brokerConnectEndpoint(broker);
        errorStore.setState(
          (current) =>
            current ??
            `Connection closed before CONNACK (${endpoint?.host}:${endpoint?.port ?? broker.port}) — wrong IP/interface or broker rejected CONNECT`,
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
      if (generation !== connectGeneration) return;
      if (connectionStateStore.getState() === 'trying') {
        errorStore.setState('Connection timeout — check broker address and port');
        connectionStateStore.setState('disconnected');
        cleanup();
      }
    }, 15000);
    } catch (err: unknown) {
      if (generation !== connectGeneration) return;
      const msg = err instanceof Error ? err.message : 'Unknown error';
      errorStore.setState(`Connection failed: ${msg}`);
      connectionStateStore.setState('disconnected');
      connectedBrokerStore.setState(null);
    }
  })();
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
  if (connectionStateStore.getState() === 'trying') return false;
  const endpoint = brokerConnectEndpoint(broker);
  if (!endpoint || validateBrokerTypePort(broker.type, endpoint.port)) return false;

  testConnectInFlight = true;
  const testTopic = `__test/${Math.random().toString(16).slice(2, 10)}`;
  const testPayload = `test-${Date.now()}`;

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const options = {
      ...mqttOptions(broker, timeoutMs),
      clientId: createMqttClientId('mqtt_test'),
    };

    void (async () => {
      try {
        const deviceIp = await getDeviceIPv4();
        const connectOpts = buildConnectOptions(broker, options, deviceIp);
        if (__DEV__) {
          console.log(connectLogLabel(broker, connectOpts, deviceIp));
        }
        const testClient = mqtt.connect(connectOpts);

        const finish = (result: boolean) => {
          if (resolved) return;
          resolved = true;
          testConnectInFlight = false;
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
      } catch {
        testConnectInFlight = false;
        resolve(false);
      }
    })();
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
    selectBroker,
    connect,
    disconnect,
    publish,
    testConnect,
    isTestInFlight: testConnectInFlight,
    clearMessages: () => messagesStore.setState([]),
    addMessage,
    setError: (value: string | null) => errorStore.setState(value),
  };
}
