import { Platform } from 'react-native';

import { createExternalStore } from '@/lib/external-store';
import { hasDevClientNativeModules } from '@/lib/native-modules';
import {
  getNativeDiscoveryMode,
  isDualDnssdAvailable,
  startNativeDiscoveryWatching,
  stopNativeDiscoveryWatching,
  restartNativeDiscoveryScan,
  subscribeNativeDiscoveryMode,
  subscribeNativeHotspotPurged,
  type DiscoveryMode,
} from '@/lib/zeroconf-native';
import type { DiscoverySegment, ServiceEntry } from '@/types/broker';

export type { DiscoveryMode };

const discoveryModeStore = createExternalStore<DiscoveryMode>('none');
let modeWired = false;
let watching = false;

export function notifyDiscoveryScanActive(active: boolean) {
  watching = active;
  if (!active) {
    setDiscoveryMode('none');
  }
}

function setDiscoveryMode(mode: DiscoveryMode) {
  if (mode === discoveryModeStore.getState()) return;
  discoveryModeStore.setState(mode);
}

function wireDiscoveryModeEvents() {
  if (modeWired || Platform.OS !== 'android' || !isDualDnssdAvailable()) return;
  modeWired = true;

  subscribeNativeDiscoveryMode((mode) => {
    setDiscoveryMode(mode);
  });
}

export function subscribeHotspotPurged(listener: () => void): () => void {
  wireDiscoveryModeEvents();
  return subscribeNativeHotspotPurged(listener);
}

export function startDiscoveryModeWatching() {
  if (Platform.OS !== 'android' || !hasDevClientNativeModules()) return;
  wireDiscoveryModeEvents();
  if (watching) return;
  watching = true;
  startNativeDiscoveryWatching();
  setDiscoveryMode(getNativeDiscoveryMode());
}

export function stopDiscoveryModeWatching() {
  if (!watching) return;
  watching = false;
  stopNativeDiscoveryWatching();
  setDiscoveryMode('none');
}

export function restartDiscoveryModeScan() {
  if (!watching || !isHotspotDiscoveryActive()) return;
  restartNativeDiscoveryScan();
}

export function useDiscoveryMode(): DiscoveryMode {
  return discoveryModeStore.useStore();
}

export function getDiscoveryMode(): DiscoveryMode {
  return discoveryModeStore.getState();
}

export function isHotspotDiscoveryActive(): boolean {
  const mode = getDiscoveryMode();
  return mode === 'hotspotOnly' || mode === 'dualHomed';
}

export function canRefreshHotspotDiscovery(): boolean {
  return Platform.OS === 'android' && watching && isHotspotDiscoveryActive();
}

export function subscribeDiscoveryModeChanges(listener: (mode: DiscoveryMode) => void): () => void {
  wireDiscoveryModeEvents();
  listener(getDiscoveryMode());
  return discoveryModeStore.subscribe(() => listener(getDiscoveryMode()));
}

export function isHotspotPurgeSignal(service: ServiceEntry): boolean {
  return service.name === '__hotspot_purge__';
}

export function emitHotspotPurgeSignal(): ServiceEntry {
  return {
    name: '__hotspot_purge__',
    type: '_mqtt-ws._tcp.',
    host: 'Unknown',
    port: 0,
    discovered: true,
    resolved: false,
    source: 'discovered',
    discoverySegment: 'hotspot',
  };
}

export function purgeDiscoveredBySegment(
  current: Record<string, ServiceEntry>,
  segment: DiscoverySegment,
): Record<string, ServiceEntry> {
  const next: Record<string, ServiceEntry> = {};
  for (const [key, service] of Object.entries(current)) {
    const svcSegment = service.discoverySegment ?? 'upstream';
    if (svcSegment !== segment) {
      next[key] = service;
    }
  }
  return next;
}
