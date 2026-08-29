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
  /**
   * Monotonic counter bumped whenever `lastResult`/`lastArgs`/`hasResult`
   * change — a cheap subscription point for keyed observers that must
   * re-check provenance on every result movement. Uninteresting to plain
   * `useResult` consumers (they subscribe on the value itself).
   */
  version: number;
  /**
   * The args tuple the current `lastResult` was fetched with, when the
   * emitting wrapper knew it. Swapped together with `lastResult` by every
   * applied emission — `undefined` means "provenance unknown" (an
   * optimistic snapshot, the accumulated pages of `useInfinite`, or an
   * `emitResult` call predating this field).
   */
  lastArgs?: any[];
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

/**
 * Broadcast store holding the latest error and failure count of an
 * injectable. Like the result store it lives on the injectable's context
 * and is shared by every consumer.
 */
export type ErrorStore = {
  error: any | undefined;
  failureCount: number;
  listeners: Set<(value: any) => void>;
};

/**
 * Per-args-key bookkeeping shared by every wrapper of one injectable: an
 * in-flight count and the last settle outcome per structural key. It is
 * the observable surface behind {@link useArgsStatus}-style hooks, which
 * read a single key's slots — so two concurrent calls with different args
 * of the same injectable report independently instead of overwriting each
 * other's injectable-level `loading`/`error`. Never rendered directly.
 */
export type KeyedStore = {
  /** One entry per key any live call has started under. Bounded: clean
   * fully-drained keys are reclaimed by the store's own settle/release
   * paths, and failure slots (observable by contract) are capped at
   * {@link KEYED_SLOTS_LIMIT} with oldest-quiescent-first eviction. */
  keyed: Map<string, {count: number; error: any; failureCount: number}>;
  /**
   * Monotonic version bumped on EVERY keyed mutation; the single
   * subscription point for `useStoreValue` consumers (a per-key listener
   * set would allocate per key without adding precision — a version bump
   * plus a keyed snapshot read is strictly cheaper).
   */
  version: number;
  listeners: Set<(version: number) => void>;
};

// Module-private store keys. The symbols are intentionally not exported:
// stores must only be reached through the helpers below.
const resultKey = Symbol('result store');
const loadingKey = Symbol('loading store');
const staleKey = Symbol('stale store');
const errorKey = Symbol('error store');
const keyedKey = Symbol('keyed store');

// Per-store call sequencing: the result of an older call must never
// overwrite the result of a newer one, no matter which wrapper emits it or
// in which order the calls settle. Errors keep their own seq space so error
// tickets never interleave with result tickets.
const resultSeqs = new WeakMap<any, {next: number; applied: number}>();
const errorSeqs = new WeakMap<any, {next: number; applied: number}>();

function seqOf(
  store: object,
  seqs: WeakMap<any, {next: number; applied: number}>
) {
  let seq = seqs.get(store);
  if (!seq) {
    seq = {next: 0, applied: 0};
    seqs.set(store, seq);
  }
  return seq;
}

/** Lazily creates and returns the shared result store of an injectable. */
export function getResultStore(fn: Func): ResultStore {
  const context = getInjectContext(fn);
  let store = context[resultKey] as ResultStore | undefined;
  if (!store) {
    store = {
      listeners: new Set(),
      lastResult: undefined,
      hasResult: false,
      version: 0
    };
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

/** Lazily creates and returns the shared error store of an injectable. */
export function getErrorStore(fn: Func): ErrorStore {
  const context = getInjectContext(fn);
  let store = context[errorKey] as ErrorStore | undefined;
  if (!store) {
    store = {listeners: new Set(), error: undefined, failureCount: 0};
    context[errorKey] = store;
  }
  return store;
}

/**
 * Reserves the call ticket handed to {@link emitResult}. Tickets are given
 * out in call order, one per emitting wrapper per call.
 */
export function nextResultSeq(store: ResultStore): number {
  return ++seqOf(store, resultSeqs).next;
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
  return seqOf(store, resultSeqs).applied;
}

/**
 * Reserves the call ticket handed to {@link emitError}. Tickets are given
 * out in call order, one per emitting wrapper per call.
 */
export function nextErrorSeq(store: ErrorStore): number {
  return ++seqOf(store, errorSeqs).next;
}

/**
 * Returns the latest error ticket already applied to the store. Emitting
 * with this value overwrites the current error WITHOUT raising the
 * sequencing watermark, so a call that reserved a newer ticket with
 * {@link nextErrorSeq} still lands afterwards.
 */
export function currentErrorSeq(store: ErrorStore): number {
  return seqOf(store, errorSeqs).applied;
}

/**
 * Stores a successful result and broadcasts it to every subscriber. A
 * result whose ticket is older than the latest applied one is dropped, so a
 * slow call can never clobber the result of a newer call.
 *
 * When `args` is given it becomes the store's `lastArgs` — the provenance
 * record `usePlaceholderData` compares the consumer's current args against.
 * An emission without `args` clears it back to "provenance unknown", so
 * `lastArgs` can never claim the displayed result belongs to args it was
 * not fetched with. Recording args never touches the ticket sequence: a
 * dropped emission discards result and args together.
 *
 * @param store the shared result store of the injectable
 * @param result the successful result to publish
 * @param seq the ticket obtained from {@link nextResultSeq} when the call started
 * @param [args] the args tuple the call was invoked with
 */
export function emitResult(
  store: ResultStore,
  result: any,
  seq: number,
  args?: any[]
) {
  const guard = seqOf(store, resultSeqs);
  if (seq < guard.applied) return;
  guard.applied = seq;
  store.lastResult = result;
  store.hasResult = true;
  store.lastArgs = args;
  store.version += 1;
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

/** Lazily creates and returns the shared keyed bookkeeping of an injectable. */
export function getKeyedStore(fn: Func): KeyedStore {
  const context = getInjectContext(fn);
  let store = context[keyedKey] as KeyedStore | undefined;
  if (!store) {
    store = {keyed: new Map(), version: 0, listeners: new Set()};
    context[keyedKey] = store;
  }
  return store;
}

/**
 * Marks one call of `key` started (count 0→1 on first, further concurrent
 * calls increment) and returns the exact undo: count−1. The slot itself is
 * NOT deleted here: wrapper order is unspecified (the onion layers settle
 * inner-first), so the sibling keyed-error emission of the same call may
 * run before or after this release — deleting here would race it. The
 * slot is reclaimed by {@link emitKeyedError} instead: a success on a
 * drained slot deletes it, a failure keeps it observable, and a failure
 * emission that finds no slot recreates one (a drained slot holding the
 * outcome). The returned release runs at most once (idempotent by `done`),
 * mirroring the `use()` pairing discipline of the memory provider.
 */
export function beginKeyedCall(store: KeyedStore, key: string): () => void {
  let slot = store.keyed.get(key);
  if (!slot) {
    slot = {count: 0, error: undefined, failureCount: 0};
    store.keyed.set(key, slot);
    evictKeyedSlots(store, key);
  } else {
    // LRU refresh: re-inserting an existing key moves it to the back of
    // the map's insertion order, so eviction (below) drops the key whose
    // last CALL is oldest — retention follows last use, not first insert.
    store.keyed.delete(key);
    store.keyed.set(key, slot);
  }
  slot.count += 1;
  store.version += 1;
  for (const listener of store.listeners) listener(store.version);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const current = store.keyed.get(key);
    if (current) {
      current.count -= 1;
      // The release is the terminal event of an out-of-order-settled key
      // (the older call's emission was dropped before this ran), so it
      // probes the same clean-drained reclaim the emission paths probe —
      // otherwise a `{count: 0, failureCount: 0}` husk would sit in the
      // map forever: nothing observable, pure retention.
      reclaimKeyedSlot(store, key);
      // Draining is also what un-blocks eviction: a burst of concurrent
      // distinct keys overshoots the cap while in flight (nothing is
      // evictable), and without this probe the overshoot would persist
      // until some LATER insertion ran one.
      evictKeyedSlots(store, key);
    }
    store.version += 1;
    for (const listener of store.listeners) listener(store.version);
  };
}

/**
 * Records the settle outcome of one call under its key. An emission whose
 * ticket is older than the latest applied one for THAT key is dropped, so
 * a slow old call can never clobber the outcome of a newer call of the
 * same args — the per-key analogue of {@link emitError}'s guard.
 * `undefined` error clears the slot's bookkeeping; a failure tallies it.
 * Every path — applied success, applied failure, dropped — first counts
 * the ticket as emitted and then probes {@link reclaimKeyedSlot}: a
 * clean, fully drained key must not outlive the last event that quiesced
 * it, no matter which of the three paths that event took.
 */
export function emitKeyedError(
  store: KeyedStore,
  key: string,
  error: any,
  seq: number
) {
  const guard = keyedSeqOf(store, key);
  guard.emitted += 1;
  const stale = seq < guard.applied;
  if (stale) {
    // A dropped emission is still an EMITTED ticket (it counts toward
    // quiescence above) and, for out-of-order-settled keys, the terminal
    // event after which nobody would probe the reclaim — probe it here.
    reclaimKeyedSlot(store, key);
    return;
  }
  guard.applied = seq;
  let slot = store.keyed.get(key);
  if (!slot) {
    // The settle order between this emission and beginKeyedCall's release
    // is unspecified (wrapper order is unspecified), so a settled-then-
    // drained call can find no slot: recreate a drained one to hold the
    // outcome. A stale zero-count slot without any settle ticket is never
    // observable (loading reads count, error reads this emission).
    slot = {count: 0, error: undefined, failureCount: 0};
    store.keyed.set(key, slot);
    evictKeyedSlots(store, key);
  }
  slot.error = error;
  slot.failureCount = error === undefined ? 0 : slot.failureCount + 1;
  // A success on a fully drained key leaves nothing observable — reclaim
  // the slot together with its guard entry (bounded retention). A failure
  // keeps the slot observable by contract; it leaves via the cap.
  reclaimKeyedSlot(store, key);
  store.version += 1;
  for (const listener of store.listeners) listener(store.version);
}

// Per-store, per-key error sequencing: the failure of an older call must
// never overwrite the settled outcome of a newer call OF THE SAME KEY.
// `emitted` counts the tickets that already ran their (applied or dropped)
// emission; `next === emitted` is therefore exactly "no ticket of this
// numbering can still arrive" — the safety condition under which the
// entry itself may be deleted (a late old ticket re-applied against a
// FRESH entry's numbering would compare against `applied: 0` and wrongly
// win). `applied` alone cannot express it: tickets below `applied` may
// still be pending when emissions land out of order.
// Exported for the retention regression tests only — base.ts is an
// internal module (the package entry points re-export nothing from it).
export const keyedSeqs = new WeakMap<
  KeyedStore,
  Map<string, {next: number; applied: number; emitted: number}>
>();

function keyedSeqOf(store: KeyedStore, key: string) {
  let perStore = keyedSeqs.get(store);
  if (!perStore) {
    perStore = new Map();
    keyedSeqs.set(store, perStore);
  }
  let seq = perStore.get(key);
  if (!seq) {
    seq = {next: 0, applied: 0, emitted: 0};
    perStore.set(key, seq);
  }
  return seq;
}

// The seq-guard entry of one key WITHOUT creating it: probing must not
// materialize entries for keys that are then kept (that would itself be
// the leak the probing exists to prevent).
const keyedSeqEntry = (
  store: KeyedStore,
  key: string
): {next: number; applied: number; emitted: number} | undefined =>
  keyedSeqs.get(store)?.get(key);

// A key is QUIESCENT when no call is in flight (`count <= 0`) and every
// reserved ticket has emitted (`next === emitted`): nothing about the old
// numbering can still arrive, so both the slot and its guard entry may go.
const keyedQuiescent = (
  store: KeyedStore,
  key: string,
  slot: {count: number}
) => {
  if (slot.count > 0) return false;
  const seq = keyedSeqEntry(store, key);
  return seq === undefined || seq.next === seq.emitted;
};

// Reclaims `key` — slot AND guard entry together — when the key is
// quiescent and the slot holds nothing observable (a success settled, or
// nothing). A clean slot and an absent one read identically through the
// keyed status hooks, so no version bump accompanies the reclaim.
// Failure slots are NOT reclaimable here: their outcome is contract state
// ("a later same-args success clears it") — they leave through the cap
// below instead.
function reclaimKeyedSlot(store: KeyedStore, key: string): boolean {
  const slot = store.keyed.get(key);
  if (!slot || slot.error !== undefined || slot.failureCount !== 0)
    return false;
  if (!keyedQuiescent(store, key, slot)) return false;
  store.keyed.delete(key);
  keyedSeqs.get(store)?.delete(key);
  return true;
}

// Retention cap of one injectable's keyed slots. Without it the map grows
// without bound: a failure slot is kept observable by contract, so an app
// enumerating many distinct args (infinite scroll, filter churn) would
// retain one slot — key string, Error reference and all — per args tuple
// it ever failed on, forever. When an insertion exceeds the cap the
// OLDEST quiescent slot (never one with live calls or pending tickets, so
// the begin/release pairing invariants are untouched) is evicted, slot
// and guard entry together. Eviction is observable (a displayed per-key
// error disappears) — the trade every bounded observability surface makes;
// insertion order doubles as the LRU clock, refreshed on every begin.
export const KEYED_SLOTS_LIMIT = 100;

// Enforces {@link KEYED_SLOTS_LIMIT}: called after `keep` was inserted
// and whenever a release drains a call — both the moments an over-limit
// map can have become evictable. Evicts oldest-first among quiescent
// keys. All-busy maps overshoot transiently — the next probe retries;
// in-flight keys are bounded by real concurrency. Callers (begin/emit/
// release) all version-bump afterwards, which carries the eviction to
// observers.
function evictKeyedSlots(store: KeyedStore, keep: string) {
  for (const [candidate, slot] of store.keyed) {
    if (store.keyed.size <= KEYED_SLOTS_LIMIT) break;
    if (candidate === keep || !keyedQuiescent(store, candidate, slot)) continue;
    store.keyed.delete(candidate);
    keyedSeqs.get(store)?.delete(candidate);
  }
}

/** Reserves the per-key error ticket of a call (call order, per key). */
export function nextKeyedErrorSeq(store: KeyedStore, key: string): number {
  return ++keyedSeqOf(store, key).next;
}

/**
 * Stores the latest error (or its clearance) and broadcasts it to every
 * subscriber. An emission whose ticket is older than the latest applied
 * one is dropped, so the failure of a slow old call can never clobber the
 * success of a newer call.
 *
 * @param store the shared error store of the injectable
 * @param error the error to publish, or `undefined` on success
 * @param seq the ticket obtained from {@link nextErrorSeq} when the call started
 */
export function emitError(store: ErrorStore, error: any, seq: number) {
  const guard = seqOf(store, errorSeqs);
  if (seq < guard.applied) return;
  guard.applied = seq;
  store.error = error;
  // A success resets the failure tally; each failure increments it.
  store.failureCount = error === undefined ? 0 : store.failureCount + 1;
  for (const listener of store.listeners) listener(error);
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
