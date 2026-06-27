import AsyncStorage from '@react-native-async-storage/async-storage';

import { createExternalStore } from '@/lib/external-store';
import { isExpoGo } from '@/lib/native-modules';
import type { ServiceEntry } from '@/types/broker';

let storageAvailable: boolean | null = null;
let storageWarned = false;

async function canUseStorage(): Promise<boolean> {
  if (storageAvailable !== null) return storageAvailable;
  if (isExpoGo()) {
    storageAvailable = false;
    return false;
  }
  try {
    await AsyncStorage.setItem('__storage_probe__', '1');
    await AsyncStorage.removeItem('__storage_probe__');
    storageAvailable = true;
  } catch {
    storageAvailable = false;
  }
  return storageAvailable;
}

function createPersistedStore<T>(key: string, initial: T) {
  const store = createExternalStore(initial);
  let hydrated = false;

  const hydrate = async () => {
    if (hydrated) return;
    hydrated = true;
    if (!(await canUseStorage())) {
      if (isExpoGo() && !storageWarned) {
        storageWarned = true;
        console.warn(
          '[MQTT Scout RN] Persistence disabled in Expo Go — use a development build (bun run ios-device).',
        );
      }
      return;
    }
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw !== null) {
        store.setState(JSON.parse(raw) as T);
      }
    } catch (error) {
      console.warn(`Error loading "${key}":`, error);
    }
  };

  const persist = async (value: T) => {
    if (!(await canUseStorage())) return;
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn(`Error saving "${key}":`, error);
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
