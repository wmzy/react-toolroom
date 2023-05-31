import type {ComponentType} from 'react';

export function thru<T>(interceptor: (v: T) => any) {
  return (v: T) => (interceptor(v), v);
}

export function thruSet<T>(set: (f: () => T) => any) {
  return (v: T) => (set(() => v), v);
}

export function thruError<E extends Error>(set: (e: E) => any) {
  return (e: E) => {
    set(e);
    throw e as Error;
  };
}

export function noop() {}

export function getDisplayName(Component: ComponentType<any>) {
  return Component.displayName || Component.name || 'Component';
}
