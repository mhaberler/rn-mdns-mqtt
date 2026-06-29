import { AppState, Platform } from 'react-native';

import { discoveredBrokerKey } from '@/lib/discovered-broker-key';
import {
  restartDiscoveryModeScan,
  subscribeDiscoveryModeChanges,
  useDiscoveryMode,
} from '@/lib/discovery-mode';
import { createExternalStore } from '@/lib/external-store';
import {
  canSoftRefreshDiscovery,
  restartAllBrokerScans,
  serviceEntryKey,
  softRefreshBrokerDiscovery,
  startAllBrokerScans,
  stopAllZeroconfScans,
  subscribeZeroconf,
} from '@/lib/zeroconf-adapter';
import type { ServiceEntry } from '@/types/broker';

const discoveredStore = createExternalStore<Record<string, ServiceEntry>>({});
let isWatching = false;
let lifecycleRegistered = false;
let zeroconfSubscribed = false;
let discoveryModeHandlerRegistered = false;

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
  if (canSoftRefreshDiscovery()) {
    softRefreshBrokerDiscovery();
    return;
  }

  discoveredStore.setState({});
  if (isWatching) {
    if (Platform.OS === 'android') {
      restartDiscoveryModeScan();
    } else {
      restartAllBrokerScans();
    }
  } else {
    startScan();
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

function ensureDiscoveryModeHandler() {
  if (discoveryModeHandlerRegistered || Platform.OS !== 'android') return;
  discoveryModeHandlerRegistered = true;
  subscribeDiscoveryModeChanges(() => {});
}

export function useMqttDiscovery() {
  ensureZeroconfSubscription();
  ensureDiscoveryModeHandler();
  registerLifecycle();

  const discoveredBrokers = discoveredStore.useStore();
  const discoveryMode = useDiscoveryMode();

  return {
    discoveredBrokers,
    liveHostFor: liveHostForFromDiscovery,
    refresh: refreshDiscovery,
    startScan,
    stopScan,
    discoveryMode,
  };
}

export { serviceEntryKey, discoveredBrokerKey };
