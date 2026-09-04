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

/**
 * Check whether a value is an `AbortSignal`.
 *
 * The `instanceof` fast path covers same-realm signals. The duck-typing
 * fallback — a non-null object with an `aborted` property and an
 * `addEventListener` function — keeps the check working for signals that
 * cross a realm boundary (created inside an iframe or by a separate test
 * environment, where `instanceof` fails) and for environments without a
 * global `AbortSignal` at all.
 */
export function isAbortSignal(value: any): boolean {
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
 * equivalent values with different insertion order hash identically; object
 * keys holding `undefined` are dropped, so `{a: 1, b: undefined}` hashes like
 * `{a: 1}` (schema outputs that omit defaulted fields and state objects that
 * carry them as `undefined` properties land on one key). Function
 * references get a per-reference incrementing id (same reference, same hash).
 * Symbols fold to a discriminating placeholder: the registry key for
 * registered ones (`sym#…`), the description for the rest (`sym:…`);
 * anonymous symbols — and distinct symbols sharing a description — collide
 * on purpose, since nothing distinguishes them structurally.
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
  if (type === 'symbol') {
    // Registered symbols (Symbol.for) carry a global identity — hash the
    // registry key. Unregistered ones only expose their description:
    // hash it, accepting that two distinct symbols sharing a description
    // collide (documented), and anonymous symbols all fold to one
    // placeholder — there is nothing to tell them apart by.
    const key = Symbol.keyFor(value);
    if (key !== undefined) return `sym#${key}`;
    const desc = value.description;
    return desc === undefined ? 'sym' : `sym:${desc}`;
  }
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
    // Keys holding `undefined` are dropped before hashing: the two sides
    // of a multi-channel key derivation must land on one hash — a schema
    // output that omits defaulted fields (no key at all) and a component
    // state object that carries them as `undefined` properties. Array
    // slots keep their position: `[undefined]` stays distinct from `[]`.
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${k}:${stableHash(value[k])}`).join(',')}}`;
  });
}

/**
 * Recursively strip the volatile parts of a value: `AbortSignal`s (at the
 * top level, inside arrays, and as object values — detected via
 * {@link isAbortSignal}, so cross-realm signals are stripped too) and
 * object keys whose value is `undefined`.
 *
 * The multi-channel use case: when several channels derive the same cache
 * key from arguments assembled differently — a router loader handing a
 * schema output (defaulted fields absent, no signal) to the provider, a
 * component handing its state object (defaulted fields present as
 * `undefined` properties) plus the trailing `AbortSignal` a `useRun`
 * rerun attached — the raw tuples hash differently even though they name
 * the same entity. `stableHash` folds a signal *value* to a fixed
 * placeholder, but the extra key/slot still participates in the
 * structural comparison; this pass removes it entirely. Compose as
 * `stableHash(stripVolatile(args))` (or hand it to a custom `hash`) and
 * every channel lands on one key.
 *
 * Arrays keep their remaining slots in order (a signal occupying a slot
 * is dropped, positional holes of literal `undefined` stay);
 * `Map`/`Set` contents pass through untouched — hash them separately if
 * needed. Not cycle-safe: argument tuples are expected to be acyclic
 * (circular structures raise a RangeError instead of hashing, unlike
 * {@link stableHash} on its own).
 *
 * @param value the value to normalize (typically an args tuple)
 * @returns a structurally equal copy without signals and undefined keys,
 *   or the value itself when it is a primitive; a top-level signal
 *   normalizes to `undefined`
 */
export function stripVolatile(value: any): any {
  if (isAbortSignal(value)) return undefined;
  if (Array.isArray(value)) {
    return value.filter((e) => !isAbortSignal(e)).map(stripVolatile);
  }
  if (value !== null && typeof value === 'object') {
    // Map/Set entries live in internal slots, invisible to Object.entries:
    // recursing them as plain objects would mangle them into {}. They pass
    // through as-is — stableHash folds signal VALUES inside them to '#sig',
    // the one structural difference this pass deliberately leaves alone.
    if (value instanceof Map || value instanceof Set) return value;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      const next = stripVolatile(v);
      if (next !== undefined) out[k] = next;
    }
    return out;
  }
  return value;
}

/**
 * Derive a cache key from an args tuple in one step — the composition
 * {@link stableHash}`(`{@link stripVolatile}`(args))`.
 *
 * The multi-channel key contract as a single call: signals stripped at
 * every depth, `undefined`-valued object keys folded away, then hashed
 * structurally. When several channels assemble the same entity's args
 * differently — a router loader handing the provider a schema output
 * (defaulted fields absent, no signal) vs a view handing its state object
 * (defaulted fields as `undefined` properties) plus the trailing
 * `AbortSignal` a `useRun` rerun attached — every one of them lands on ONE
 * key without each call site hand-writing the composition. The signature
 * also slots straight into the `hash` options of
 * `createMemoryCacheProvider` and `useRun` for caches whose tuples carry
 * volatile slots.
 *
 * @param args the argument tuple to hash
 * @returns the structural hash of the normalized tuple
 */
export function hashArgs(args: unknown[]): string {
  return stableHash(stripVolatile(args));
}
