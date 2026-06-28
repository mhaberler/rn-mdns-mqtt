import { requireOptionalNativeModule, EventSubscription } from 'expo-modules-core';
import { Platform } from 'react-native';

export type DiscoveryMode = 'none' | 'hotspotOnly' | 'dualHomed';

export type HotspotServiceEvent = {
  segment?: 'upstream' | 'hotspot';
  name: string;
  type: string;
  host?: string;
  port?: number;
  txtRecord?: Record<string, string>;
  ipv4Addresses?: string[];
  ipv6Addresses?: string[];
};

type HotspotMdnsNativeModule = {
  startWatching: () => void;
  stopWatching: () => void;
  restartScan: () => void;
  isDualHomed: () => boolean;
  getDiscoveryMode: () => DiscoveryMode;
  addListener: (
    eventName: string,
    listener: (event: Record<string, unknown>) => void,
  ) => EventSubscription;
  removeListeners: (count: number) => void;
};

const NativeModule =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<HotspotMdnsNativeModule>('HotspotMdns')
    : null;

export function isHotspotMdnsAvailable(): boolean {
  return NativeModule != null;
}

export function startHotspotWatching(): void {
  NativeModule?.startWatching();
}

export function stopHotspotWatching(): void {
  NativeModule?.stopWatching();
}

export function restartHotspotScan(): void {
  NativeModule?.restartScan();
}

export function isDualHomedNative(): boolean {
  return NativeModule?.isDualHomed() ?? false;
}

export function getDiscoveryModeNative(): DiscoveryMode {
  return NativeModule?.getDiscoveryMode() ?? 'none';
}

export function addHotspotMdnsListener(
  eventName:
    | 'onDualHomedChanged'
    | 'onDiscoveryModeChanged'
    | 'onServiceFound'
    | 'onServiceResolved'
    | 'onServiceRemoved'
    | 'onHotspotPurged',
  listener: (event: Record<string, unknown>) => void,
): EventSubscription | undefined {
  return NativeModule?.addListener(eventName, listener);
}
