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

const functionHashIds = new WeakMap<object, string>();
let functionHashId = 0;
const circularGuard = new WeakSet<object>();

function isAbortSignal(value: any): boolean {
  if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) {
    return true;
  }
  // Duck-typing fallback for environments without a global AbortSignal.
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    typeof value.addEventListener === 'function'
  );
}

function withCycleGuard(value: object, hash: () => string): string {
  if (circularGuard.has(value)) return '#circ';
  circularGuard.add(value);
  try {
    return hash();
  } finally {
    circularGuard.delete(value);
  }
}

/**
 * Compute a stable, structural hash for any value.
 *
 * Primitives are prefixed by type so that e.g. `1` and `'1'` never collide.
 * Object keys are sorted, and `Map` entries / `Set` values are sorted, so that
 * equivalent values with different insertion order hash identically. Function
 * references get a per-reference incrementing id (same reference, same hash).
 * `AbortSignal` maps to the fixed placeholder `'#sig'` so that keyed caches stay
 * stable across calls that pass a fresh signal. Circular references map to
 * `'#circ'` instead of throwing.
 *
 * @param value the value to hash
 * @returns a deterministic string identifying the value
 */
export function stableHash(value: any): string {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  const type = typeof value;
  if (type === 'string') return `s:${value}`;
  if (type === 'number' || type === 'boolean' || type === 'bigint') {
    return `${type}:${value}`;
  }
  if (type === 'function') {
    let id = functionHashIds.get(value);
    if (id === undefined) {
      id = `f:${++functionHashId}`;
      functionHashIds.set(value, id);
    }
    return id;
  }
  if (type === 'symbol') return 'sym';
  if (value instanceof Date) {
    return `d:${Number.isNaN(value.getTime()) ? 'Invalid' : value.toISOString()}`;
  }
  if (isAbortSignal(value)) return '#sig';
  if (Array.isArray(value)) {
    return withCycleGuard(
      value,
      () => `[${value.map((item) => stableHash(item)).join(',')}]`
    );
  }
  if (value instanceof Map) {
    return withCycleGuard(value, () => {
      const entries = Array.from(
        value,
        ([k, v]) => `${stableHash(k)}=>${stableHash(v)}`
      ).sort();
      return `Map{${entries.join(',')}}`;
    });
  }
  if (value instanceof Set) {
    return withCycleGuard(value, () => {
      const values = Array.from(value, (item) => stableHash(item)).sort();
      return `Set{${values.join(',')}}`;
    });
  }
  return withCycleGuard(value, () => {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${k}:${stableHash(value[k])}`).join(',')}}`;
  });
}
