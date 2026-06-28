import type { DiscoveryMode } from '@/lib/zeroconf-native.android';

export type { DiscoveryMode };

export function isDualDnssdAvailable(): boolean {
  return false;
}

export function startNativeDiscoveryWatching(): void {}

export function stopNativeDiscoveryWatching(): void {}

export function restartNativeDiscoveryScan(): void {}

export function getNativeDiscoveryMode(): DiscoveryMode {
  return 'none';
}

export function subscribeNativeDiscoveryMode(_listener: (mode: DiscoveryMode) => void): () => void {
  return () => {};
}

export function subscribeNativeHotspotPurged(_listener: () => void): () => void {
  return () => {};
}

export const BROWSE_KEY_UPSTREAM = 'upstream';
export const BROWSE_KEY_HOTSPOT = 'hotspot';
