import { useEffect, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

let isActive = AppState.currentState === 'active';
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return isActive;
}

AppState.addEventListener('change', (nextState: AppStateStatus) => {
  const active = nextState === 'active';
  if (active !== isActive) {
    isActive = active;
    listeners.forEach((listener) => listener());
  }
});

export function useAppLifecycle() {
  const active = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { isActive: active };
}

export function useAppLifecycleEffect(onActiveChange: (active: boolean) => void) {
  const { isActive } = useAppLifecycle();

  useEffect(() => {
    onActiveChange(isActive);
  }, [isActive, onActiveChange]);
}
