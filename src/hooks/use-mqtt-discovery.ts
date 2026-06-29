import { AppState } from 'react-native';

import { mergeAddressLists, pickConnectHost } from '@/lib/broker-host';
import { discoveredBrokerKey } from '@/lib/discovered-broker-key';
import { createExternalStore } from '@/lib/external-store';
import {
  serviceEntryKey,
  startAllBrokerScans,
  startAllBrokerScansAsync,
  stopAllZeroconfScans,
  subscribeZeroconf,
} from '@/lib/zeroconf-adapter';
import type { ServiceEntry } from '@/types/broker';

const discoveredStore = createExternalStore<Record<string, ServiceEntry>>({});
let isWatching = false;
let lifecycleRegistered = false;
let zeroconfSubscribed = false;

function onServiceEvent(action: 'added' | 'removed' | 'resolved', service: ServiceEntry) {
  const key = discoveredBrokerKey(service);

  if (action === 'added') {
    discoveredStore.setState((current) => {
      const existing = current[key];
      if (existing?.resolved) return current;
      return {
        ...current,
        [key]: {
          ...service,
          discovered: true,
          resolved: false,
          source: 'discovered',
        },
      };
    });
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
      const ipv4Addresses = mergeAddressLists(existing?.ipv4Addresses, service.ipv4Addresses);
      const ipv6Addresses = mergeAddressLists(existing?.ipv6Addresses, service.ipv6Addresses);
      const host = pickConnectHost({
        host: service.host || existing?.host,
        ipv4Addresses,
        ipv6Addresses,
      });
      return {
        ...current,
        [key]: {
          ...existing,
          ...service,
          name: service.name || existing?.name || `${service.type ?? 'service'} Service`,
          type: service.type || existing?.type || '',
          host,
          port: service.port,
          domain: service.domain || existing?.domain,
          discovered: true,
          resolved: true,
          source: 'discovered',
          txtRecord: service.txtRecord || existing?.txtRecord || {},
          ipv4Addresses,
          ipv6Addresses,
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
  void stopAllZeroconfScans();
}

export async function refreshDiscovery() {
  const wasWatching = isWatching;
  if (wasWatching) {
    isWatching = false;
    await stopAllZeroconfScans();
  }
  discoveredStore.setState({});
  if (wasWatching) {
    isWatching = true;
    await startAllBrokerScansAsync();
  }
}

export function liveHostForFromDiscovery(
  name: string,
  type: string,
): Pick<ServiceEntry, 'host' | 'port' | 'ipv4Addresses' | 'ipv6Addresses'> | null {
  const match = Object.values(discoveredStore.getState()).find(
    (s) => s.name === name && s.type === type && s.resolved,
  );
  if (!match) return null;
  return {
    host: match.host,
    port: match.port,
    ipv4Addresses: match.ipv4Addresses,
    ipv6Addresses: match.ipv6Addresses,
  };
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

export { serviceEntryKey, discoveredBrokerKey };
