import { Platform } from 'react-native';

import { pickConnectHost } from '@/lib/broker-host';
import { createExternalStore } from '@/lib/external-store';
import { hasDevClientNativeModules } from '@/lib/native-modules';
import { serviceTypeFromFullName } from '@/lib/service-type';
import type { DiscoverySegment, ServiceEntry } from '@/types/broker';
import {
  addHotspotMdnsListener,
  getDiscoveryModeNative,
  isHotspotMdnsAvailable,
  restartHotspotScan,
  startHotspotWatching,
  stopHotspotWatching,
  type DiscoveryMode,
  type HotspotServiceEvent,
} from 'hotspot-mdns';

export type HotspotDiscoveryAction = 'added' | 'removed' | 'resolved';

export type HotspotDiscoveryEvent = {
  action: HotspotDiscoveryAction;
  service: ServiceEntry;
};

type HotspotDiscoveryListener = (event: HotspotDiscoveryEvent) => void;
type DiscoveryModeListener = (mode: DiscoveryMode) => void;

const listeners = new Set<HotspotDiscoveryListener>();
const modeListeners = new Set<DiscoveryModeListener>();
let wired = false;
let watching = false;
const discoveryModeStore = createExternalStore<DiscoveryMode>('none');
const subscriptions: { remove: () => void }[] = [];

function getDiscoveryModeState(): DiscoveryMode {
  return discoveryModeStore.getState();
}

function emit(event: HotspotDiscoveryEvent) {
  listeners.forEach((listener) => listener(event));
}

function emitDiscoveryMode(mode: DiscoveryMode) {
  modeListeners.forEach((listener) => listener(mode));
}

function segmentFrom(raw: HotspotServiceEvent & { segment?: string }): DiscoverySegment {
  return raw.segment === 'hotspot' ? 'hotspot' : 'upstream';
}

function mapSegmentService(
  raw: HotspotServiceEvent,
  action: HotspotDiscoveryAction,
): ServiceEntry | null {
  const type =
    raw.type ||
    serviceTypeFromFullName(raw.name) ||
    (raw.type?.includes('wss') ? '_mqtt-wss._tcp.' : '_mqtt-ws._tcp.');

  const ipv4 = raw.ipv4Addresses ?? [];
  const ipv6 = raw.ipv6Addresses ?? [];
  const host = pickConnectHost({
    host: raw.host,
    ipv4Addresses: ipv4,
    ipv6Addresses: ipv6,
  });

  return {
    name: raw.name,
    type,
    host,
    port: raw.port ?? 0,
    domain: 'local',
    discovered: true,
    resolved: action === 'resolved' && (raw.port ?? 0) > 0,
    source: 'discovered',
    discoverySegment: segmentFrom(raw),
    txtRecord: raw.txtRecord ?? {},
    ipv4Addresses: ipv4,
    ipv6Addresses: ipv6,
  };
}

function setDiscoveryMode(next: DiscoveryMode) {
  if (next === getDiscoveryModeState()) return;
  discoveryModeStore.setState(next);
  emitDiscoveryMode(next);
}

function wireEvents() {
  if (wired || !isHotspotMdnsAvailable()) return;
  wired = true;

  subscriptions.push(
    addHotspotMdnsListener('onDiscoveryModeChanged', (event) => {
      const mode = event.mode as DiscoveryMode;
      if (mode === 'none' || mode === 'hotspotOnly' || mode === 'dualHomed') {
        setDiscoveryMode(mode);
      }
    }) ?? { remove: () => {} },
  );

  subscriptions.push(
    addHotspotMdnsListener('onServiceFound', (event) => {
      const mapped = mapSegmentService(event as HotspotServiceEvent, 'added');
      if (!mapped) return;
      emit({ action: 'added', service: mapped });
    }) ?? { remove: () => {} },
  );

  subscriptions.push(
    addHotspotMdnsListener('onServiceResolved', (event) => {
      const mapped = mapSegmentService(event as HotspotServiceEvent, 'resolved');
      if (!mapped || mapped.port <= 0) return;
      emit({ action: 'resolved', service: mapped });
    }) ?? { remove: () => {} },
  );

  subscriptions.push(
    addHotspotMdnsListener('onServiceRemoved', (event) => {
      const mapped = mapSegmentService(event as HotspotServiceEvent, 'removed');
      if (!mapped) return;
      emit({ action: 'removed', service: mapped });
    }) ?? { remove: () => {} },
  );

  subscriptions.push(
    addHotspotMdnsListener('onHotspotPurged', () => {
      emit({
        action: 'removed',
        service: {
          name: '__hotspot_purge__',
          type: '_mqtt-ws._tcp.',
          host: 'Unknown',
          port: 0,
          discovered: true,
          resolved: false,
          source: 'discovered',
          discoverySegment: 'hotspot',
        },
      });
    }) ?? { remove: () => {} },
  );
}

export function subscribeHotspotDiscovery(listener: HotspotDiscoveryListener): () => void {
  wireEvents();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function subscribeDiscoveryModeChanges(listener: DiscoveryModeListener): () => void {
  wireEvents();
  modeListeners.add(listener);
  listener(getDiscoveryModeState());
  return () => modeListeners.delete(listener);
}

/** @deprecated Use subscribeDiscoveryModeChanges */
export function subscribeDualHomedChanges(listener: (dualHomed: boolean) => void): () => void {
  return subscribeDiscoveryModeChanges((mode) => listener(mode === 'dualHomed'));
}

export function startHotspotDiscovery() {
  if (Platform.OS !== 'android' || !hasDevClientNativeModules()) return;
  wireEvents();
  if (watching) return;
  watching = true;
  startHotspotWatching();
  setDiscoveryMode(getDiscoveryModeNative());
}

export function stopHotspotDiscovery() {
  if (!watching) return;
  watching = false;
  stopHotspotWatching();
  setDiscoveryMode('none');
}

export function restartHotspotDiscovery() {
  if (!watching || !isHotspotDiscoveryActive()) return;
  restartHotspotScan();
}

export function getDiscoveryMode(): DiscoveryMode {
  return getDiscoveryModeState();
}

export function useDiscoveryMode(): DiscoveryMode {
  return discoveryModeStore.useStore();
}

export function isDualHomedDiscovery(): boolean {
  return getDiscoveryModeState() === 'dualHomed';
}

export function isHotspotDiscoveryActive(): boolean {
  const mode = getDiscoveryModeState();
  return mode === 'hotspotOnly' || mode === 'dualHomed';
}

export function canRefreshHotspotDiscovery(): boolean {
  return Platform.OS === 'android' && watching && isHotspotDiscoveryActive();
}

export function isHotspotPurgeSignal(service: ServiceEntry): boolean {
  return service.name === '__hotspot_purge__';
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
