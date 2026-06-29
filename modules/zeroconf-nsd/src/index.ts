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

type ZeroconfNsdNativeModule = {
  watchAll(types: string[], domain: string): Promise<void>;
  unwatchAll(types: string[], domain: string): Promise<void>;
  close(): Promise<void>;
  addListener(eventName: 'onService', listener: (event: NsdServiceEvent) => void): EventSubscription;
};

let nativeModule: ZeroconfNsdNativeModule | null = null;

function getNativeModule(): ZeroconfNsdNativeModule {
  if (!nativeModule) {
    nativeModule = requireNativeModule<ZeroconfNsdNativeModule>('ZeroconfNsd');
  }
  return nativeModule;
}

export async function watchAll(types: string[], domain: string): Promise<void> {
  await getNativeModule().watchAll(types, domain);
}

export async function unwatchAll(types: string[], domain: string): Promise<void> {
  await getNativeModule().unwatchAll(types, domain);
}

export async function closeDiscovery(): Promise<void> {
  await getNativeModule().close();
}

export function addServiceListener(listener: (event: NsdServiceEvent) => void): EventSubscription {
  return getNativeModule().addListener('onService', listener);
}

export function isZeroconfNsdAvailable(): boolean {
  try {
    requireNativeModule('ZeroconfNsd');
    return true;
  } catch {
    return false;
  }
}
