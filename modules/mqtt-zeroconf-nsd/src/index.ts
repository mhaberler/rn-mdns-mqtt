import { type EventSubscription, requireNativeModule } from 'expo-modules-core';

export type NsdServiceAction = 'added' | 'resolved' | 'removed';

export type NsdService = {
  domain: string;
  type: string;
  name: string;
  port: number;
  hostname: string;
  ipv4Addresses: string[];
  ipv6Addresses: string[];
  txtRecord?: Record<string, string>;
};

export type NsdServiceEvent = {
  action: NsdServiceAction;
  service: NsdService;
};

type MqttZeroconfNsdNativeModule = {
  watch(type: string, domain: string): Promise<void>;
  unwatch(type: string, domain: string): Promise<void>;
  close(): Promise<void>;
  addListener(eventName: 'onService', listener: (event: NsdServiceEvent) => void): EventSubscription;
};

let nativeModule: MqttZeroconfNsdNativeModule | null = null;

function getNativeModule(): MqttZeroconfNsdNativeModule {
  if (!nativeModule) {
    nativeModule = requireNativeModule<MqttZeroconfNsdNativeModule>('MqttZeroconfNsd');
  }
  return nativeModule;
}

export async function watchService(type: string, domain: string): Promise<void> {
  await getNativeModule().watch(type, domain);
}

export async function unwatchService(type: string, domain: string): Promise<void> {
  await getNativeModule().unwatch(type, domain);
}

export async function closeDiscovery(): Promise<void> {
  await getNativeModule().close();
}

export function addServiceListener(listener: (event: NsdServiceEvent) => void): EventSubscription {
  return getNativeModule().addListener('onService', listener);
}

export function isMqttZeroconfNsdAvailable(): boolean {
  try {
    requireNativeModule('MqttZeroconfNsd');
    return true;
  } catch {
    return false;
  }
}
