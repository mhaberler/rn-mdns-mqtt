import { AppState } from 'react-native';

import { createExternalStore } from '@/lib/external-store';
import {
  removeLeadingAndTrailingDots,
} from '@/lib/service-type';
import {
  serviceEntryKey,
  startAllBrokerScans,
  stopAllZeroconfScans,
  subscribeZeroconf,
} from '@/lib/zeroconf-adapter';
import type { ServiceEntry } from '@/types/broker';

const discoveredStore = createExternalStore<Record<string, ServiceEntry>>({});
let isWatching = false;
let lifecycleRegistered = false;
let zeroconfSubscribed = false;

function onServiceEvent(action: 'added' | 'removed' | 'resolved', service: ServiceEntry) {
  const st = removeLeadingAndTrailingDots(service.type || '');
  const key = `${service.name || 'unknown'}_${service.domain || 'local'}_${st}`;

  if (action === 'added') {
    discoveredStore.setState((current) => ({
      ...current,
      [key]: {
        ...service,
        discovered: true,
        resolved: false,
        source: 'discovered',
      },
    }));
    return;
  }

  if (action === 'removed') {
    discoveredStore.setState((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    return;
  }

  if (action === 'resolved' && service.port > 0) {
    discoveredStore.setState((current) => {
      const existing = current[key];
      return {
        ...current,
        [key]: {
          ...existing,
          ...service,
          name: service.name || existing?.name || `${service.type ?? 'service'} Service`,
          type: service.type || existing?.type || '',
          host: service.host || existing?.host || 'Unknown',
          port: service.port,
          domain: service.domain || existing?.domain,
          discovered: true,
          resolved: true,
          source: 'discovered',
          txtRecord: service.txtRecord || existing?.txtRecord || {},
          ipv4Addresses: service.ipv4Addresses || existing?.ipv4Addresses || [],
          ipv6Addresses: service.ipv6Addresses || existing?.ipv6Addresses || [],
        },
      };
    });
  }
}

export function startScan() {
  if (isWatching) return;
  isWatching = true;
  startAllBrokerScans();
}

export function stopScan() {
  if (!isWatching) return;
  isWatching = false;
  stopAllZeroconfScans();
}

export async function refreshDiscovery() {
  stopScan();
  discoveredStore.setState({});
  startScan();
}

export function liveHostForFromDiscovery(name: string, type: string): { host: string; port: number } | null {
  const match = Object.values(discoveredStore.getState()).find(
    (s) => s.name === name && s.type === type && s.resolved,
  );
  if (!match) return null;
  return { host: match.host, port: match.port };
}

function registerLifecycle() {
  if (lifecycleRegistered) return;
  lifecycleRegistered = true;

  AppState.addEventListener('change', (nextState) => {
    if (nextState === 'active') startScan();
    else stopScan();
  });

  if (AppState.currentState === 'active') {
    startScan();
  }
}

function ensureZeroconfSubscription() {
  if (zeroconfSubscribed) return;
  zeroconfSubscribed = true;
  subscribeZeroconf(({ action, service }) => {
    onServiceEvent(action, service);
  });
}

export function useMqttDiscovery() {
  ensureZeroconfSubscription();
  registerLifecycle();

  const discoveredBrokers = discoveredStore.useStore();

  return {
    discoveredBrokers,
    liveHostFor: liveHostForFromDiscovery,
    refresh: refreshDiscovery,
    startScan,
    stopScan,
  };
}

export { serviceEntryKey };
