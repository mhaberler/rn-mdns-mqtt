import { useSyncExternalStore } from 'react';

export function createExternalStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();

  const getState = () => state;

  const setState = (next: T | ((prev: T) => T)) => {
    state = typeof next === 'function' ? (next as (prev: T) => T)(state) : next;
    listeners.forEach((listener) => listener());
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const useStore = () => useSyncExternalStore(subscribe, getState, getState);

  return { getState, setState, subscribe, useStore };
}
