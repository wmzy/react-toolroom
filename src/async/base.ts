import {AsyncFunc, Func} from '@@/types';
import {useCallback, useEffect, useSyncExternalStore, useState} from 'react';
import {getInjectContext} from './inject';

export function useLoadingFn() {
  const [count, setCount] = useState(0);
  const withLoading = <P extends Promise<any>>(p: P) => (
    setCount((c) => c + 1),
    p.finally(() => setCount((c) => c - 1))
  );
  const wrap = <AF extends AsyncFunc>(fn: AF) =>
    ((...args: Parameters<AF>) => withLoading(fn(...args))) as AF;
  return [Boolean(count), wrap] as const;
}

// Subscription protocol: the stores' `listeners` sets hold the
// `onStoreChange` callbacks handed over by useSyncExternalStore (see
// useStoreValue below) instead of per-consumer value listeners. The
// `emitResult`/`emitLoading` broadcast semantics are unchanged — every
// listener is still invoked with the new value; the uSES callbacks ignore
// the argument and let React re-read the snapshot.

/**
 * Broadcast store holding the latest successful result of an injectable. It
 * lives on the injectable's context, so every consumer of the same
 * injectable shares one store.
 */
export type ResultStore = {
  listeners: Set<(result: any) => void>;
  lastResult: any;
  hasResult: boolean;
};

/**
 * Broadcast store counting the in-flight calls of an injectable. Like the
 * result store it lives on the injectable's context and is shared by every
 * consumer.
 */
export type LoadingStore = {
  count: number;
  listeners: Set<(count: number) => void>;
};

/**
 * Broadcast store holding the staleness flag of an injectable. Like the
 * result store it lives on the injectable's context and is shared by every
 * consumer.
 */
export type StaleStore = {
  stale: boolean;
  listeners: Set<(stale: boolean) => void>;
};

// Module-private store keys. The symbols are intentionally not exported:
// stores must only be reached through the helpers below.
const resultKey = Symbol('result store');
const loadingKey = Symbol('loading store');
const staleKey = Symbol('stale store');

// Per-store call sequencing: the result of an older call must never
// overwrite the result of a newer one, no matter which wrapper emits it or
// in which order the calls settle.
const resultSeqs = new WeakMap<ResultStore, {next: number; applied: number}>();

function seqOf(store: ResultStore) {
  let seq = resultSeqs.get(store);
  if (!seq) {
    seq = {next: 0, applied: 0};
    resultSeqs.set(store, seq);
  }
  return seq;
}

/** Lazily creates and returns the shared result store of an injectable. */
export function getResultStore(fn: Func): ResultStore {
  const context = getInjectContext(fn);
  let store = context[resultKey] as ResultStore | undefined;
  if (!store) {
    store = {listeners: new Set(), lastResult: undefined, hasResult: false};
    context[resultKey] = store;
  }
  return store;
}

/** Lazily creates and returns the shared loading store of an injectable. */
export function getLoadingStore(fn: Func): LoadingStore {
  const context = getInjectContext(fn);
  let store = context[loadingKey] as LoadingStore | undefined;
  if (!store) {
    store = {listeners: new Set(), count: 0};
    context[loadingKey] = store;
  }
  return store;
}

/** Lazily creates and returns the shared stale store of an injectable. */
export function getStaleStore(fn: Func): StaleStore {
  const context = getInjectContext(fn);
  let store = context[staleKey] as StaleStore | undefined;
  if (!store) {
    store = {listeners: new Set(), stale: false};
    context[staleKey] = store;
  }
  return store;
}

/**
 * Reserves the call ticket handed to {@link emitResult}. Tickets are given
 * out in call order, one per emitting wrapper per call.
 */
export function nextResultSeq(store: ResultStore): number {
  return ++seqOf(store).next;
}

/**
 * Returns the latest ticket already applied to the store. Emitting with
 * this value overwrites the current result WITHOUT raising the sequencing
 * watermark, so a call that reserved a newer ticket with
 * {@link nextResultSeq} still lands afterwards — which is exactly what an
 * optimistic snapshot needs: it must never block the real result of its
 * own call.
 */
export function currentResultSeq(store: ResultStore): number {
  return seqOf(store).applied;
}

/**
 * Stores a successful result and broadcasts it to every subscriber. A
 * result whose ticket is older than the latest applied one is dropped, so a
 * slow call can never clobber the result of a newer call.
 *
 * @param store the shared result store of the injectable
 * @param result the successful result to publish
 * @param seq the ticket obtained from {@link nextResultSeq} when the call started
 */
export function emitResult(store: ResultStore, result: any, seq: number) {
  const guard = seqOf(store);
  if (seq < guard.applied) return;
  guard.applied = seq;
  store.lastResult = result;
  store.hasResult = true;
  for (const listener of store.listeners) listener(result);
}

/** Updates the in-flight count and broadcasts it to every subscriber. */
export function emitLoading(store: LoadingStore, count: number) {
  store.count = count;
  for (const listener of store.listeners) listener(count);
}

/** Updates the stale flag and broadcasts it to every subscriber. */
export function emitStale(store: StaleStore, stale: boolean) {
  store.stale = stale;
  for (const listener of store.listeners) listener(stale);
}

// React 18+ exports useSyncExternalStore; React 16.8–17 peers do not, and
// under CommonJS interop the named import resolves to `undefined` instead
// of throwing, so older peers fall back to the shim below. The shim has no
// tearing protection, but its subscriptions live in effects — which only
// run for committed renders — so discarded concurrent renders can no longer
// leak listeners either.
const useSES =
  (useSyncExternalStore as ((s: any, g: () => any) => any) | undefined) ??
  useSESFallback;

function useSESFallback(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => any
) {
  // The lazy initializer captures the first-frame snapshot.
  const [snapshot, setSnapshot] = useState(getSnapshot);
  useEffect(() => {
    let mounted = true;
    const check = () => {
      if (mounted) setSnapshot(getSnapshot());
    };
    // Stores mutate before broadcasting, so a change landing between the
    // render that read the snapshot and this effect needs one synchronous
    // catch-up check on top of the subscription.
    check();
    const unsubscribe = subscribe(check);
    return () => {
      // The unsubscribe alone removes `check` from the store; `mounted`
      // additionally guards the unmount batch itself, where a broadcast
      // must not resurrect a setState on a dead component.
      mounted = false;
      unsubscribe();
    };
  }, [subscribe, getSnapshot]);
  return snapshot;
}

/**
 * Reads a value out of a shared store through `useSyncExternalStore`, so
 * React owns the subscription lifecycle: committed renders are tearing-safe
 * and discarded concurrent renders never leave listeners behind.
 *
 * `getSnapshot` must return a value that stays referentially equal until
 * the store broadcasts — plain store fields such as `count`, `hasResult`,
 * or `lastResult` qualify, since `emitResult`/`emitLoading` swap them in
 * place before notifying. Callers must memoize `getSnapshot` (e.g. with
 * `useCallback`) to avoid resubscribing on every render.
 *
 * @param store the store to read from
 * @param getSnapshot a stable callback returning the current store value
 */
export function useStoreValue<T>(
  store: {listeners: Set<(value: any) => void>},
  getSnapshot: () => T
): T {
  // The store lives on the injectable's context, so it is referentially
  // stable for the lifetime of the consumer, and so is this `subscribe`
  // callback — uSES therefore subscribes exactly once per store.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      store.listeners.add(onStoreChange);
      return () => {
        store.listeners.delete(onStoreChange);
      };
    },
    [store]
  );
  return useSES(subscribe, getSnapshot);
}
