import AsyncStorage from '@react-native-async-storage/async-storage';

import { createExternalStore } from '@/lib/external-store';
import type { ServiceEntry } from '@/types/broker';

function createPersistedStore<T>(key: string, initial: T) {
  const store = createExternalStore(initial);
  let hydrated = false;

  const hydrate = async () => {
    if (hydrated) return;
    hydrated = true;
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw !== null) {
        store.setState(JSON.parse(raw) as T);
      }
    } catch (error) {
      console.error(`Error loading "${key}":`, error);
    }
  };

  const persist = async (value: T) => {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error(`Error saving "${key}":`, error);
    }
  };

  const setValue = (next: T | ((prev: T) => T)) => {
    store.setState(next);
    void persist(store.getState());
  };

  return { ...store, hydrate, setValue };
}

const preferredStore = createPersistedStore<ServiceEntry | null>('preferredBroker', null);
const manualStore = createPersistedStore<ServiceEntry[]>('manualBrokers', []);

let hydrationStarted = false;

function ensureHydrated() {
  if (hydrationStarted) return;
  hydrationStarted = true;
  void preferredStore.hydrate();
  void manualStore.hydrate();
}

export function useAppState() {
  ensureHydrated();

  const preferredBroker = preferredStore.useStore();
  const manualBrokers = manualStore.useStore();

  return {
    preferredBroker,
    setPreferredBroker: preferredStore.setValue,
    manualBrokers,
    setManualBrokers: manualStore.setValue,
  };
}

export function getPreferredBrokerSnapshot() {
  return preferredStore.getState();
}
