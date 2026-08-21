import {AsyncFunc, Func} from '@@/types';
import {useEffect, useState} from 'react';
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

// Module-private store keys. The symbols are intentionally not exported:
// stores must only be reached through the helpers below.
const resultKey = Symbol('result store');
const loadingKey = Symbol('loading store');

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

/**
 * Reserves the call ticket handed to {@link emitResult}. Tickets are given
 * out in call order, one per emitting wrapper per call.
 */
export function nextResultSeq(store: ResultStore): number {
  return ++seqOf(store).next;
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

/**
 * Subscribes `listener` to a store's broadcasts using a render-safe
 * protocol: the listener is added during render (`Set#add` is idempotent,
 * so repeated and StrictMode double renders never duplicate the entry),
 * re-added inside an effect, and removed on cleanup so an unmounted
 * component stops receiving broadcasts.
 *
 * `listener` must be referentially stable across renders — a `useState`
 * setter qualifies.
 *
 * @param store the store to subscribe to
 * @param listener a stable callback invoked with every broadcast value
 */
export function useBroadcast<T>(
  store: {listeners: Set<(value: T) => void>},
  listener: (value: T) => void
) {
  store.listeners.add(listener);
  useEffect(() => {
    store.listeners.add(listener);
    return () => {
      store.listeners.delete(listener);
    };
    // Both are stable: the store lives on the injectable's context and the
    // listener is required to be a stable reference.
  }, [store, listener]);
}
