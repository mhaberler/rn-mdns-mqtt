import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

export type DiscoveryMode = 'none' | 'hotspotOnly' | 'dualHomed';

const ANDROID_IMPL = 'DNSSD';

type RNZeroconfNative = {
  scan: (type: string, protocol: string, domain: string, implType: string) => void;
  stop: (implType: string) => void;
  startDiscoveryWatching: (implType: string) => void;
  stopDiscoveryWatching: (implType: string) => void;
  restartDiscoveryScan: (implType: string) => void;
  getDiscoveryMode: (implType: string) => DiscoveryMode;
};

const native = NativeModules.RNZeroconf as RNZeroconfNative | undefined;

export const ZCONF_EVENT_DISCOVERY_MODE = 'RNZeroconfDiscoveryModeChanged';
export const ZCONF_EVENT_HOTSPOT_PURGED = 'RNZeroconfHotspotPurged';
export const BROWSE_KEY_UPSTREAM = 'upstream';
export const BROWSE_KEY_HOTSPOT = 'hotspot';

export function isDualDnssdAvailable(): boolean {
  return Platform.OS === 'android' && !!native?.startDiscoveryWatching;
}

export function startNativeDiscoveryWatching(): void {
  native?.startDiscoveryWatching(ANDROID_IMPL);
}

export function stopNativeDiscoveryWatching(): void {
  native?.stopDiscoveryWatching(ANDROID_IMPL);
}

export function restartNativeDiscoveryScan(): void {
  native?.restartDiscoveryScan(ANDROID_IMPL);
}

export function getNativeDiscoveryMode(): DiscoveryMode {
  if (!native?.getDiscoveryMode) return 'none';
  const mode = native.getDiscoveryMode(ANDROID_IMPL);
  if (mode === 'hotspotOnly' || mode === 'dualHomed') return mode;
  return 'none';
}

export function subscribeNativeDiscoveryMode(listener: (mode: DiscoveryMode) => void): () => void {
  const sub = DeviceEventEmitter.addListener(ZCONF_EVENT_DISCOVERY_MODE, (mode: string) => {
    if (mode === 'hotspotOnly' || mode === 'dualHomed') listener(mode);
    else listener('none');
  });
  return () => sub.remove();
}

export function subscribeNativeHotspotPurged(listener: () => void): () => void {
  const sub = DeviceEventEmitter.addListener(ZCONF_EVENT_HOTSPOT_PURGED, listener);
  return () => sub.remove();
}
