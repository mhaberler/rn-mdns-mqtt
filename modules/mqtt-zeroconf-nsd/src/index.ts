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

const NativeModule = requireNativeModule<MqttZeroconfNsdNativeModule>('MqttZeroconfNsd');

export async function watchService(type: string, domain: string): Promise<void> {
  await NativeModule.watch(type, domain);
}

export async function unwatchService(type: string, domain: string): Promise<void> {
  await NativeModule.unwatch(type, domain);
}

export async function closeDiscovery(): Promise<void> {
  await NativeModule.close();
}

export function addServiceListener(listener: (event: NsdServiceEvent) => void): EventSubscription {
  return NativeModule.addListener('onService', listener);
}

export function isMqttZeroconfNsdAvailable(): boolean {
  try {
    requireNativeModule('MqttZeroconfNsd');
    return true;
  } catch {
    return false;
  }
}
