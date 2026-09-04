/**
 * This module includes the hooks for data-fetching.
 * Hooks can be combined with other hooks.
 *
 * @example
 * ```tsx
 * import {
 *   useResult,
 *   useLoading,
 *   useInitialLoading,
 *   useRun,
 *   useInjectable,
 *   useError,
 *   createMemoryCacheProvider,
 *   useCache
 * } from 'react-toolroom/async';
 * import {fetchList} from '@/services/user';
 *
 * const cache = createMemoryCacheProvider<any, any[]>({
 *   cacheTime: 10000,
 *   hash: (k: any[]) => JSON.stringify(k)
 * });
 *
 * export default function Async() {
 *   const fetchUserList = useInjectable(fetchList);
 *   const isStale = useCache(fetchUserList, cache, 2000);
 *   const users = useResult(fetchUserList);
 *   const loading = useLoading(fetchUserList);
 *   const initialLoading = useInitialLoading(fetchUserList);
 *   const error = useError(fetchUserList);
 *
 *   useRun(fetchUserList, []);
 *
 *   if (initialLoading) return 'loading...';
 *   if (error) {
 *     return (
 *       <div>
 *         <h1>{error.message}</h1>
 *         <pre>{error.stack}</pre>
 *         <button type='button' onClick={() => fetchUserList()}>
 *           refresh
 *         </button>
 *       </div>
 *     );
 *   }
 *
 *   return (
 *     <div>
 *       <div>
 *         <button type='button' onClick={() => fetchUserList()}>
 *           refresh
 *         </button>
 *         <button type='button' onClick={() => fetchUserList(-1)}>
 *           refresh(Error)
 *         </button>
 *       </div>
 *       {loading && <p>refreshing…</p>}
 *       {isStale && <p>data was stale</p>}
 *       <ul>
 *         {users?.map((user) => (
 *           <li key={user.id}>{user.username}</li>
 *         ))}
 *       </ul>
 *     </div>
 *   );
 * }
 * ```
 * @module
 */

import {AsyncFunc, CacheProvider, CacheResult, Func, R} from '@@/types';
import {useCallback, useEffect, useRef, useState} from 'react';
import {isAbortSignal, noop, stableHash, thru, thruError} from '@@/util';
import {
  useInject,
  useInjectBefore,
  useInjectable,
  getInjectContext,
  isInjectable,
  useSwallowCell
} from './inject';
import {
  ErrorStore,
  LoadingStore,
  ResultStore,
  claimErrorEmission,
  emitError,
  emitKeyedStale,
  emitLoading,
  emitResult,
  beginKeyedCall,
  emitKeyedError,
  getKeyedStore,
  getErrorStore,
  getLoadingStore,
  getResultStore,
  nextErrorSeq,
  nextKeyedErrorSeq,
  nextResultSeq,
  resetError,
  trimTrailingSignal,
  useStoreValue
} from './base';
import {
  InvalidateTarget,
  ValidatedTargets,
  bindCacheRevalidation,
  getObservedSet,
  getPendingSet,
  invalidate,
  isCacheProvider
} from './invalidation';
import createMemoryCacheProvider from '../memory-cache-provider';

export {useInject, useInjectBefore, getInjectContext, isInjectable};
export type {
  AsyncFunc,
  Func,
  R,
  CacheProvider,
  CacheResult,
  CacheEvent
} from '@@/types';

export {useOptimistic} from './optimistic';
export {useInfinite} from './infinite';

export {invalidate} from './invalidation';
export type {InvalidateTarget} from './invalidation';

export {subscribeInjectEvents} from './devtools';

// Returns the injectable's shared result store with its emission wiring
// kept alive: while any result consumer is mounted, every call through the
// injectable publishes its resolved value into the store. Both result
// hooks below need exactly this, so their broadcast semantics are
// identical by construction.
function useEmittingResultStore<AF extends AsyncFunc>(
  injectableFn: AF
): ResultStore {
  const store = getResultStore(injectableFn);
  useInject(
    injectableFn,
    (f: AF) =>
      ((...args) => {
        const seq = nextResultSeq(store);
        return f(...args).then(
          thru<R<AF>>((r) => emitResult(store, r, seq, args))
        );
      }) as AF
  );
  return store;
}

/**
 * Get the result of a wrapped async function. Results are broadcast through
 * a store shared by every consumer of the same injectable, so all subscribed
 * components update together, and components mounting after a call resolved
 * start from the shared last result.
 * @param injectableFn the wrapped async function
 * @param [init] the initial value, used until any result has arrived
 * @returns the result
 * @see {@link useResultSelect} to subscribe to a projected slice only
 */
export function useResult<AF extends AsyncFunc>(
  injectableFn: AF
): R<AF> | undefined;
export function useResult<AF extends AsyncFunc>(
  injectableFn: AF,
  init: R<AF>
): R<AF>;
// The fallback for an optional init: `useResult(fn, options?.initialData)`
// passes `R<AF> | undefined`, and a possibly-absent init can only promise
// `R<AF> | undefined` back. Without this overload such calls would fall
// through to the implementation signature and type as `unknown`.
export function useResult<AF extends AsyncFunc>(
  injectableFn: AF,
  init: R<AF> | undefined
): R<AF> | undefined;
export function useResult<AF extends AsyncFunc>(
  injectableFn: AF,
  init?: R<AF>
): R<AF> | undefined {
  type RAF = R<AF>;
  const store = useEmittingResultStore(injectableFn);
  // `init` only applies to the first frame and is captured once, so later
  // changes to the prop never leak into an ongoing render stream.
  const [initial] = useState<RAF | undefined>(() =>
    store.hasResult ? store.lastResult : init
  );
  // Late subscribers start from the shared last result instead of `init`,
  // so they render data immediately without re-running the request.
  return useStoreValue(
    store,
    useCallback(
      () => (store.hasResult ? store.lastResult : initial),
      [store, initial]
    )
  );
}

/**
 * Subscribe to a projected slice of a wrapped async function's result —
 * this library's `select`, named after its source. Same shared store and
 * broadcast semantics as {@link useResult}, but the component only ever
 * sees the projection.
 * @param injectableFn the wrapped async function
 * @param select the projection applied to the result and to `init`
 * @param [init] the initial value, projected and used until any result has
 * arrived; a possibly-absent init (`options?.initialData`) is accepted and
 * yields `T | undefined`
 * @returns the projected slice, `undefined` until a result or `init`
 * exists — `select` is not called while neither exists
 */
export function useResultSelect<AF extends AsyncFunc, T>(
  injectableFn: AF,
  select: (result: R<AF>) => T
): T | undefined;
export function useResultSelect<AF extends AsyncFunc, T>(
  injectableFn: AF,
  select: (result: R<AF>) => T,
  init: R<AF>
): T;
export function useResultSelect<AF extends AsyncFunc, T>(
  injectableFn: AF,
  select: (result: R<AF>) => T,
  init: R<AF> | undefined
): T | undefined;
export function useResultSelect<AF extends AsyncFunc, T>(
  injectableFn: AF,
  select: (result: R<AF>) => T,
  init?: R<AF>
): T | undefined {
  type RAF = R<AF>;
  const store = useEmittingResultStore(injectableFn);
  // `init` only applies to the first frame and is captured once, so later
  // changes to the prop never leak into an ongoing render stream.
  const [initial] = useState<RAF | undefined>(() =>
    store.hasResult ? store.lastResult : init
  );
  // Last-input/last-output memo. `useSyncExternalStore` requires
  // `getSnapshot` to return a referentially stable value for a given store
  // state; a selector that builds a fresh object per call would look like an
  // ever-changing snapshot and trip React's "getSnapshot should be cached"
  // loop detection. The projection is therefore cached against the exact
  // input and selector it was computed from — unchanged identities return
  // the cached output, so unrelated re-renders neither re-run `select` nor
  // change the projected reference, while a new result or a new `select`
  // (e.g. one rebuilt from state via `useCallback`) recomputes.
  const cell = useRef<{
    input: unknown;
    selector: unknown;
    output: T | undefined;
  }>(undefined);
  // Late subscribers start from the shared last result instead of `init`,
  // so they render data immediately without re-running the request.
  return useStoreValue(
    store,
    useCallback(() => {
      const input = store.hasResult ? store.lastResult : initial;
      const last = cell.current;
      const memo =
        last === undefined || last.input !== input || last.selector !== select
          ? {
              input,
              selector: select,
              output: input === undefined ? undefined : select(input as RAF)
            }
          : last;
      cell.current = memo;
      return memo.output;
    }, [store, initial, select])
  );
}

/**
 * Returns `true` while the result currently on display was not fetched
 * with `args` — the observable flag of this library's default
 * keep-previous-data behavior. TanStack Query needs
 * `placeholderData: keepPreviousData` to keep the old data on a key
 * change; here that is already the default (the shared result store is
 * never reset between calls), and this hook tells the consumer WHICH data
 * it is looking at: `true` means "the previous args' result (or the
 * `placeholderData` fallback), dim it / spin a top indicator", `false`
 * means "the real result for the current args".
 *
 * The flag is computed structurally: both the recorded provenance of the
 * displayed result and `args` pass through `stableHash`, so re-renders
 * with a fresh-but-equal args literal do not flip it, and a trailing
 * `AbortSignal` appended by `useRun`'s `{signal: true}` is ignored on
 * both sides. Results whose provenance is unknown — an optimistic
 * snapshot, the accumulated pages of `useInfinite` — are never claimed
 * as placeholders. Pair with `useResult(fn, placeholderData)` so the
 * fallback value is actually displayed while the first load is pending.
 *
 * @param {AsyncFunc} injectableFn - the wrapped async function to watch.
 * @param {Parameters<AF>} args - the args tuple the consumer is currently
 *   rendering for — pass the very tuple handed to `useRun`.
 * @param {R<AF>} [placeholderData] - when given, the flag is also `true`
 *   before the first result ever arrives (the fallback display window).
 * @returns {boolean} whether the displayed result belongs to `args`.
 * @example
 * ```tsx
 * const fetchPage = useInjectable((query: {page: number}) => api.list(query));
 * useRun(fetchPage, [{page}], {hash: stableHash});
 * const rows = useResult(fetchPage);
 * const isPlaceholderData = usePlaceholderData(fetchPage, [{page}]);
 *
 * return <Table rows={rows} dimmed={isPlaceholderData} />;
 * ```
 */
export function usePlaceholderData<AF extends AsyncFunc>(
  injectableFn: AF,
  args: Parameters<AF>,
  placeholderData?: R<AF>
): boolean {
  const store = getResultStore(injectableFn);
  const argsKey = stableHash(trimTrailingSignal(args));
  // The snapshot is a boolean, so it is naturally stable between
  // broadcasts; it is recomputed whenever the args key or the fallback
  // changes, which is exactly when the verdict can differ.
  return useStoreValue(
    store,
    useCallback(() => {
      if (!store.hasResult) return placeholderData !== undefined;
      if (store.lastArgs === undefined) return false;
      return stableHash(trimTrailingSignal(store.lastArgs)) !== argsKey;
    }, [store, argsKey, placeholderData])
  );
}

// Module-private in-flight slot key, following the store-key pattern of
// base.ts: the slot is reachable only through useSuspenseResult below. It
// holds the promise a suspending consumer should throw while the first
// result is pending — thrown as-is, so a rejection surfaces on the nearest
// error boundary instead of silently hanging the fallback.
const suspenseKey = Symbol('suspense in-flight promise');

type SuspenseSlot = {
  promise: Promise<any> | undefined;
  /** DEV-only: one stall warning per injectable (see warnIfSuspenseStalled). */
  stallWarned?: boolean;
};

/** Lazily creates and returns the shared in-flight slot of an injectable. */
function getSuspenseSlot(fn: Func): SuspenseSlot {
  const context = getInjectContext(fn);
  let slot = context[suspenseKey] as SuspenseSlot | undefined;
  if (!slot) {
    slot = {promise: undefined};
    context[suspenseKey] = slot;
  }
  return slot;
}

// DEV-only stall detector. `firstResultPromise` below never settles while
// no call runs, so a driver that is never started leaves the boundary on
// its fallback forever — the deadlock the docs warn about (a driver inside
// the suspended subtree never runs its effects). The warning waits out a
// grace window first: a suspension thrown during the first render pass is
// EXPECTED to outlive the pass — the driver (a parent's useRun) starts
// from an effect, which runs only after this render committed the
// fallback. Only when the window passes with no result AND no in-flight
// call does the heuristic conclude nobody is coming. It is a hint, not an
// error: a deliberately delayed driver (debounced input, enable gating)
// may still start later.
const suspenseStallGraceMs = 1000;

/** Schedules the one-shot DEV stall warning of a fresh suspension. */
function warnIfSuspenseStalled(store: ResultStore, slot: SuspenseSlot): void {
  if (slot.stallWarned) return;
  slot.stallWarned = true;
  setTimeout(() => {
    if (store.hasResult || slot.promise !== undefined) return;
    // eslint-disable-next-line no-console -- the dev warning IS the feature
    console.warn(
      'useSuspenseResult: suspended with no call in flight and no result ' +
        'yet — a driver that never starts leaves this boundary on its ' +
        'fallback forever. Start the fetch from a parent OUTSIDE the ' +
        'Suspense boundary (useRun or a manual call); a driver inside the ' +
        'suspended subtree never runs.'
    );
  }, suspenseStallGraceMs);
}

// Suspends until the shared result store publishes anything: the listener
// removes itself on the first result, so an abandoned suspension (e.g. the
// boundary unmounted before any call settled) never leaks. Used when no
// in-flight promise has been recorded yet — the fetch has simply not been
// started, e.g. it is driven from outside the suspended subtree or starts
// later in the same render pass. Never settles while no call runs: the
// DEV-only stall warning above is the only signal that deadlock emits.
function firstResultPromise(store: ResultStore): Promise<void> {
  return new Promise((resolve) => {
    const wake = () => {
      store.listeners.delete(wake);
      resolve();
    };
    store.listeners.add(wake);
  });
}

/**
 * Like {@link useResult}, but suspends the component until the first
 * result exists instead of returning `undefined`: rendered inside a
 * `<Suspense>` boundary, the hook hands React the in-flight promise to
 * await, so loading states become declarative fallback UI.
 *
 * The hook only reads — it never starts a call. Running the injectable
 * stays the job of `useRun`, polling, or manual calls. Note that a subtree
 * suspended on its initial mount never commits and so never runs its
 * effects: a `useRun` driving the first load must live outside the
 * suspended subtree (or the call must be started before/elsewhere). If the
 * grace window of ~1s passes with no result and no call in flight, DEV
 * builds warn about the stalled suspension — a driver that never starts
 * leaves the boundary on its fallback forever. Once the first result has
 * arrived, every later result flows in through the shared result store
 * exactly like `useResult`.
 *
 * @param injectableFn the wrapped async function
 * @returns the result (the component suspends until the first one exists)
 * @example
 * ```tsx
 * import {Suspense} from 'react';
 * import {useRun, useSuspenseResult} from 'react-toolroom/async';
 * import {fetchList} from '@/services/user';
 *
 * // The owner drives the fetch and sits outside the Suspense boundary,
 * // so its effect fires even while the reader below is suspended.
 * function UserList() {
 *   const fetchUserList = useInjectable(fetchList);
 *   useRun(fetchUserList, []);
 *   return (
 *     <Suspense fallback={<p>loading…</p>}>
 *       <UserListReader fetchUserList={fetchUserList} />
 *     </Suspense>
 *   );
 * }
 *
 * function UserListReader({fetchUserList}: {fetchUserList: typeof fetchList}) {
 *   const users = useSuspenseResult(fetchUserList);
 *   return (
 *     <ul>
 *       {users.map((user) => (
 *         <li key={user.id}>{user.username}</li>
 *       ))}
 *     </ul>
 *   );
 * }
 * ```
 */
export function useSuspenseResult<AF extends AsyncFunc>(
  injectableFn: AF
): R<AF> {
  const store = getResultStore(injectableFn);
  const slot = getSuspenseSlot(injectableFn);

  useInject(
    injectableFn,
    (f: AF) =>
      ((...args) => {
        const seq = nextResultSeq(store);
        // The promise suspending consumers throw: settling it publishes
        // the result first and clears the slot second (both are handlers
        // of this chain, in that order), so the retry render React
        // schedules on this very promise always finds `hasResult` set.
        const promise = f(...args).then(
          thru<R<AF>>((r) => emitResult(store, r, seq, args))
        );
        slot.promise = promise;
        const settle = () => {
          // A newer call may already occupy the slot — only clear our own
          // promise, never the fresh one.
          if (slot.promise === promise) slot.promise = undefined;
        };
        promise.then(settle, settle);
        return promise;
      }) as AF
  );

  // The hook order must not depend on the suspension state: both hooks
  // above run unconditionally, the throw below only ever afterwards.
  const result = useStoreValue(
    store,
    useCallback(() => store.lastResult, [store])
  );

  if (store.hasResult) return result;

  // DEV-only stall detector: fires when the grace window passes with no
  // result and no in-flight call — the "driver never started" deadlock.
  if (process.env.NODE_ENV !== 'production') warnIfSuspenseStalled(store, slot);

  // Suspend: on the recorded in-flight promise when someone has already
  // started the call (rejections then reach the error boundary), otherwise
  // on a promise resolved by the first result published to the store.
  throw slot.promise ?? firstResultPromise(store);
}

/**
 * This function is a custom hook that caches the result of an asynchronous function and returns it if it exists
 * in the cache. If not, it calls the function and caches the result for future calls. It also sets a stale time
 * after which the result is considered outdated and will be refetched on the next call. The hook returns a boolean
 * indicating whether the result is stale or not.
 *
 * Cached data is broadcast to every subscriber of the injectable the moment
 * it is found (SWR semantics): subscribers render the cached value at once
 * and are updated again when a background refetch completes.
 *
 * `stale` is keyed state, just like the result's provenance: each args
 * tuple carries its own verdict in the injectable's keyed store, and the
 * hook returns the verdict of the tuple the displayed result was fetched
 * with — one tuple going stale can no longer flip the flag of another
 * tuple's display. With a single args tuple (the common case) every
 * consumer still reads one shared verdict and updates together. Each
 * consumer still registers its own wrapper, so a call still performs the
 * cache lookup once per consumer.
 *
 * Invalidation is provider-driven: the `invalidates` option of
 * `useMutation` and `invalidate()` only purge the provider, and this hook
 * subscribes to its deletion events — whenever entries this consumer has
 * seen are removed (by anything), it re-runs their tuples through the
 * wrapper chain and broadcasts the fresh results (see
 * {@link invalidate}).
 *
 * Providers that implement `load` get in-flight sharing for free: every
 * fetch this hook starts (a miss or a stale background revalidation) goes
 * through `provider.load(args, factory)`, so concurrent consumers — and any
 * other channel reading the same provider — share one request whose
 * settle write-back the provider guards itself. Providers without `load`
 * keep the classic path: run the inner chain, then `set`.
 *
 * @param {AsyncFunc} injectableFn - the asynchronous function to memoize
 * @param {CacheProvider} cacheProvider - the cache provider for the function results
 * @param {number} staleTime - the time in milliseconds after which the cached result is considered stale
 * @return {boolean} a boolean indicating whether the cached result is stale or not
 */
export function useCache<AF extends AsyncFunc>(
  injectableFn: AF,
  cacheProvider: CacheProvider<R<AF>, Parameters<AF>>,
  staleTime = 0
) {
  const store = getResultStore(injectableFn);
  // Staleness lives per key in the keyed store (see emitKeyedStale): with
  // several args tuples in flight, one tuple's verdict can no longer
  // clobber another's on a single injectable-level flag.
  const keyedStore = getKeyedStore(injectableFn);
  // This consumer's own seen-set: every args tuple its wrapper below has
  // fetched, structurally keyed with the latest raw tuple winning. It is
  // hook-local state, dropped on unmount, so a departed consumer's queries
  // are never re-run by a later purge of the provider.
  const seenRef = useRef<Map<string, any[]>>(undefined);
  if (!seenRef.current) seenRef.current = new Map();
  const seen = seenRef.current;
  // The verdict of the DISPLAYED key: `lastKey` is the structural args key
  // the displayed result was fetched with (emitResult maintains it), so
  // the boolean reads the tuple actually on screen — the useArgsStatus
  // subscription pattern (keyed version + result provenance), but with a
  // boolean snapshot so unchanged verdicts still bail out of re-renders.
  // No result (or provenance unknown — an optimistic snapshot, the
  // accumulated pages of useInfinite) means no key to have a verdict for:
  // false, the absent default.
  const readStale = useCallback(() => {
    if (!store.hasResult || store.lastKey === undefined) return false;
    return keyedStore.keyed.get(store.lastKey)?.stale === true;
  }, [store, keyedStore]);
  useStoreValue(keyedStore, readStale);
  const stale = useStoreValue(store, readStale);

  useEffect(cacheProvider.use, []);

  // GC exemption while mounted: the tuples this consumer has fetched stay
  // observed for as long as it is on screen, so the provider's per-entry
  // sweep never reaps an entry someone is watching (TanStack Query keeps a
  // query with observers alive the same way). Observation is counted per
  // consumer — the fetch wrapper records the reference for its consumer
  // whenever it records `seen` (idempotently per key), and the consumer's
  // unmount releases them. The wrapper chain is shared by every consumer
  // of the same underlying function, so the wrapper marks eagerly and each
  // consumer's own cleanup effect releases its references at unmount.
  // Providers without the optional `observe` member simply skip this —
  // the sweep stays args-blind for them.
  const observe = cacheProvider.observe;
  const observedSet = getObservedSet(injectableFn, cacheProvider);
  useEffect(() => {
    if (!observe) return;
    // No observe-on here: the wrapper is the only marking point, and it is
    // idempotent per key (`if (!seen.has(key))`). The useInject wrapper is
    // installed during the insertion-effect phase, before any passive
    // effect — including this one — runs, so any call made before this
    // effect already passed through the wrapper and was counted. Marking
    // again here would double-count keys first fetched before this effect
    // ran (trigger hook declared above `useCache`, or a child calling while
    // a parent holds `useCache`), leaking permanent exemptions.
    for (const tuple of seen.values()) observedSet.add(stableHash(tuple));
    return () => {
      // Release this consumer's references. `seen` is this consumer's own
      // map, dropped with the hook instance — the tuples it releases are
      // exactly the ones its wrapper observed.
      const released = [...seen.values()] as Parameters<AF>[];
      if (released.length) observe(released, false);
      for (const tuple of released) observedSet.delete(stableHash(tuple));
    };
  }, [cacheProvider, seen, observe, observedSet]);

  // Passive revalidation — the other half of the invalidation model:
  // `invalidate()` (and the `invalidates` option of `useMutation`) only
  // purge the provider; whenever entries THIS consumer has seen are removed
  // (by anything — invalidate, deletePrefix, a devtools panel, expiry),
  // their tuples are re-run through the injectable's full wrapper chain:
  // a hard cache miss that refetches and broadcasts, exactly like a focus
  // revalidation. Providers without the optional `subscribe` member get no
  // passive revalidation — entries still purge, and the next explicit call
  // fetches fresh.
  useEffect(
    () => bindCacheRevalidation(injectableFn, cacheProvider, seen),
    [injectableFn, cacheProvider, seen]
  );

  useInject(
    injectableFn,
    (f: AF) =>
      ((...args: Parameters<AF>) => {
        const key = stableHash(args);
        // GC exemption: mark the tuple observed the moment this consumer
        // fetches it. Idempotent per key — `on` fires only when the key is
        // new to this consumer's `seen`, no matter how often the key is
        // re-called (polling, refocus, stale revalidation, cache hits), so
        // the provider's per-key reference count stays balanced with the
        // consumer's single release-on-unmount. StrictMode's double-invoked
        // effects are safe the same way: catch-up and cleanup touch the
        // same seen-key set and pair exactly.
        if (!seen.has(key)) observe?.([args], true);
        seen.set(key, args);
        observedSet.add(key);
        const seq = nextResultSeq(store);
        // The provenance-scoped key every verdict below addresses — the
        // same derivation emitResult stamps into the store (`lastKey`).
        const verdictKey = stableHash(trimTrailingSignal(args));
        const refetch = () => {
          const publish = thru<R<AF>>((r) => {
            // With a load-capable provider the settle write-back belongs to
            // the provider itself (generation-guarded against writes that
            // landed mid-flight); the legacy path keeps its write-through.
            if (!cacheProvider.load) cacheProvider.set(args, r);
            emitResult(store, r, seq, args);
            emitKeyedStale(keyedStore, verdictKey, false);
          });
          // Routing through `load` shares ONE in-flight promise across every
          // consumer of these args — and every other channel using the same
          // provider (another component's injectable, a router loader) —
          // with the factory, i.e. the whole inner wrapper chain including
          // any useRetry loop, running exactly once. A call whose args end
          // in an AbortSignal gets abort-yield for free inside the
          // provider's load (see memory-cache-provider).
          return cacheProvider.load
            ? cacheProvider.load(args, () => f(...args)).then(publish)
            : f(...args).then(publish);
        };
        return new Promise<CacheResult<R<AF>>>((resolve) => {
          resolve(cacheProvider.get(args));
        })
          .catch(() => undefined)
          .then((cached: CacheResult<R<AF>>) => {
            if (!cached) return refetch();
            const [data, cachedAt] = cached;
            const isStale = Date.now() - cachedAt >= staleTime;
            emitKeyedStale(keyedStore, verdictKey, isStale);
            // Broadcast the cached data right away so every subscriber
            // renders it without waiting for the network. The cached value
            // was fetched with these very args, so they are recorded as
            // its provenance — a revisited page is not a placeholder.
            emitResult(store, data, seq, args);
            if (isStale) {
              // The background revalidation is fire-and-forget: failures are
              // swallowed silently so the stale data stays on screen. A cache
              // miss above still propagates refetch() rejections to the caller.
              refetch().catch(noop);
            }
            return data;
          });
      }) as AF
  );
  return stale;
}

/**
 * A custom hook that returns a stable invalidation function for a cached
 * injectable: calling it deletes the cache entry under its arguments and
 * immediately re-runs the injectable with those same arguments.
 *
 * The key linkage mirrors `useCache`: only entries written through the same
 * `cacheProvider` with the same argument tuple can be deleted, because the
 * provider hashes the raw args tuple into the cache key. The typical use is
 * a mutation success path — `invalidate(fetchUsers, userCache)()` forces the
 * list to be fetched anew. Unlike a `useCache` background refetch, which
 * keeps serving the stale value while refreshing, this is a hard
 * invalidation: the entry is gone before the call starts, so subscribers
 * see a fresh loading/result cycle instead of the old value.
 *
 * @param {AsyncFunc} injectableFn - the injectable to invalidate and re-run
 * @param {CacheProvider} cacheProvider - the same cache provider passed to `useCache`
 * @return {function} a stable function that deletes the cache entry under its arguments, then calls the injectable with them and resolves to the fresh result
 * @example
 * ```tsx
 * const fetchUsers = useInjectable(getUsers);
 * const usersCache = createMemoryCacheProvider<User[], any[]>();
 * useCache(fetchUsers, usersCache);
 * const invalidateUsers = useInvalidate(fetchUsers, usersCache);
 *
 * async function handleSubmit(user: NewUser) {
 *   await createUser(user);
 *   // drop the cached list and refetch it right away
 *   await invalidateUsers();
 * }
 * ```
 */
export function useInvalidate<AF extends AsyncFunc>(
  injectableFn: AF,
  cacheProvider: CacheProvider<R<AF>, Parameters<AF>>
): (...args: Parameters<AF>) => Promise<R<AF>> {
  return useCallback(
    (...args: Parameters<AF>) => {
      // Claim the revalidation slot BEFORE the delete: the provider's
      // deletion event would otherwise make mounted `useCache` consumers
      // re-run the same args, fetching a second time. Our explicit call
      // below is the one that refetches; the claim is released when it
      // settles. (The old model never notified consumers at all — the new
      // one refreshes them through the event for every other entry.)
      //
      // The signal twin is claimed too: under a signal-stripping custom
      // `hash`, deleting the plain tuple hits an entry a `useRun({signal:
      // true})` call wrote (raw tuple ends in a signal), and the event
      // carries THAT raw tuple — its `stableHash` is the `#sig`-shaped
      // twin key, not the plain one. Claiming only the plain key left the
      // twin-addressed event unclaimed, so consumers re-ran and joined our
      // own call through the provider's in-flight dedupe: one fetch, two
      // wrapper-chain settles — a doubled failureCount for one failed
      // call. `stableHash` collapses every signal instance to the same
      // placeholder, so one twin claim covers all signal varieties.
      const pending = getPendingSet(injectableFn, cacheProvider);
      const key = stableHash(args);
      const twinKey = stableHash([...args, new AbortController().signal]);
      pending.add(key);
      pending.add(twinKey);
      cacheProvider.delete(args);
      const call = injectableFn(...args) as Promise<R<AF>>;
      call.finally(() => {
        pending.delete(key);
        pending.delete(twinKey);
      });
      return call;
    },
    [injectableFn, cacheProvider]
  );
}

/**
 * A custom hook that receives an injectable function and a catcher function
 * that handles any thrown error. It returns a modified version of the injectable
 * function that catches any errors thrown and passes them to the catcher function.
 *
 * @param {AsyncFunc} injectableFn - The original function to be modified.
 * @param {(e: Error) => R<AsyncFunc>} catcher - A function that handles any error thrown.
 * @return {void} This function does not return anything.
 */
export function useCatch<E extends Error, AF extends AsyncFunc>(
  injectableFn: AF,
  catcher: (e: E) => R<AF>
) {
  useInject(
    injectableFn,
    (f: AF) => ((...args) => f(...args).catch(thru(catcher))) as AF
  );
}

/**
 * Creates a new function that injects the original function and calls its finally method
 * after the function completes execution.
 *
 * @param {AF} injectableFn - The original function to inject.
 * @param {() => any} handler - The handler function to run after the function completes execution.
 * @return {void} - No return value.
 */
export function useFinally<AF extends AsyncFunc>(
  injectableFn: AF,
  handler: () => any
) {
  useInject(
    injectableFn,
    (f: AF) => ((...args) => f(...args).finally(handler)) as AF
  );
}

/**
 * Injects a wrapper that publishes every failure and success of the
 * injectable on its shared error store and returns that store.
 */
function useErrorWrapper<AF extends AsyncFunc>(injectableFn: AF): ErrorStore {
  const store = getErrorStore(injectableFn);
  // Per-key outcome mirror, keyed like useLoadingWrapper's: each call
  // reserves its own ticket (call order per key) and publishes settle +
  // error under it, so concurrent different-args calls of one injectable
  // report independently. seq ordering mirrors emitError's guarantee.
  const keyedStore = getKeyedStore(injectableFn);
  useInject(
    injectableFn,
    (f: AF, callContext: any) =>
      ((...args) => {
        // This layer serves the call's settle emission; alternative
        // emitters riding the same call (usePolling's tick tracking)
        // read the claim after the synchronous fold and stay passive.
        claimErrorEmission(callContext);
        // Same key derivation as the read side (useArgsStatus) — trailing
        // AbortSignal trimmed, see useLoadingWrapper's mirror comment.
        const key = stableHash(trimTrailingSignal(args));
        const seq = nextErrorSeq(store);
        const keyedSeq = nextKeyedErrorSeq(keyedStore, key);
        return f(...args)
          .then(
            thru(() => {
              emitError(store, undefined, seq);
              emitKeyedError(keyedStore, key, undefined, keyedSeq);
            })
          )
          .catch(
            thruError((e: any) => {
              emitError(store, e, seq);
              emitKeyedError(keyedStore, key, e, keyedSeq);
            })
          );
      }) as AF
  );
  return store;
}

/**
 * A hook that accepts an async function and returns any errors thrown.
 *
 * The error lives on a store shared by every consumer of the injectable
 * (injectable-level broadcast, like {@link useResult}): all subscribed
 * components update together, components mounting after a call failed
 * start from the shared error, and the failure of a slow old call never
 * clobbers the success of a newer call. A success clears the error.
 *
 * @param {AsyncFunc} injectableFn - The async function to be executed.
 * @return {Error} The error thrown by the async function.
 */
export function useError<E extends Error, AF extends AsyncFunc = AsyncFunc>(
  injectableFn: AF
): E | undefined {
  // Mounting this hook claims the instance's errors: failures resolve
  // `undefined` at the call boundary instead of rejecting — the reader has
  // declared ownership, so nobody else needs the rejection. Unmount the
  // last reader and rejections flow to callers again (see useSwallowCell).
  useSwallowCell(injectableFn);
  const store = useErrorWrapper(injectableFn);
  // Plain store field swapped in place by emitError — a stable snapshot.
  return useStoreValue(
    store,
    useCallback(() => store.error, [store])
  );
}

/**
 * Returns a count of the number of times the provided async function has failed.
 *
 * The count lives on the shared error store of the injectable, so every
 * consumer reads the same tally and components mounting late start from
 * its current value. A success resets it to 0.
 *
 * @param {AF} injectableFn - the async function to inject and count failures of
 * @return {number} the count of failures
 */
export function useFailureCount<AF extends AsyncFunc>(injectableFn: AF) {
  useSwallowCell(injectableFn);
  const store = useErrorWrapper(injectableFn);
  return useStoreValue(
    store,
    useCallback(() => store.failureCount, [store])
  );
}

/** Lifecycle callbacks of one mutation — naming aligned with TanStack/SWR. */
export type MutationOptions<
  M extends AsyncFunc,
  T extends readonly unknown[] = readonly InvalidateTarget[]
> = {
  /** Fires synchronously right before the call starts. */
  onMutate?: (...args: Parameters<M>) => void;
  /** Fires with the resolved value when the call succeeds. */
  onSuccess?: (result: R<M>, ...args: Parameters<M>) => void;
  /** Fires with the rejection when the call fails. */
  onError?: (error: Error, ...args: Parameters<M>) => void;
  /** Fires exactly once per call, after `onSuccess` or `onError`. */
  onSettled?: (
    result: R<M> | undefined,
    error: Error | undefined,
    ...args: Parameters<M>
  ) => void;
  /**
   * Serialize calls that resolve to the same scope key — TanStack Query's
   * `mutationKey` + `scope` semantics. A string queues as-is; a function
   * is evaluated with the mutate arguments at call time, so the queue
   * position (FIFO) follows call order. Calls sharing a key execute one
   * after another — a queued call waits until every earlier same-scope
   * call settles — while different keys run in parallel; scope-less calls
   * are untouched. The chain is module-level: queued calls still run after
   * the calling component unmounts, and a failure never breaks the chain
   * (later calls keep executing). `isMutating` counts a queued call from
   * the moment it is made. A scope function that throws — or resolves to
   * a falsy key — falls back to scope-less parallel behavior.
   */
  scope?: string | ((...args: Parameters<M>) => string);
  /**
   * Cache targets to purge when the call succeeds — declarative
   * invalidation for the common "write, then refresh what the write
   * touched" flow. Each entry is a cache provider (all of its entries) or
   * a `[provider, ...argsPrefix]` tuple (entries whose raw args tuple
   * extends the prefix); a failed mutation invalidates nothing. Purging is
   * a pure cache operation — mounted `useCache` consumers refresh through
   * the provider's own deletion event. See {@link invalidate}.
   */
  invalidates?: readonly [...T] & ValidatedTargets<T>;
};

/** What {@link useMutation} hands to your components. */
export type MutationStatus = {
  /** `true` while any call is in flight (concurrent calls all count). */
  isMutating: boolean;
  /** The latest error; a later success clears it. Shared per injectable. */
  error: Error | undefined;
  /** Consecutive failures so far; a success resets it to `0`. */
  failureCount: number;
  /**
   * The derived lifecycle, TanStack Query's `mutation.status` semantics
   * on the `isMutating` clock: `'idle'` before any call and after
   * `reset`, `'pending'` from the moment a call is made (a scope-queued
   * call is pending while it *waits*, exactly like `isMutating` counts
   * it), `'success'` after the latest settled call succeeded, `'error'`
   * after it failed. A call in flight dominates: `reset` during one
   * keeps `pending` — the in-flight ticket stays valid and its outcome
   * still lands afterwards.
   */
  status: 'idle' | 'pending' | 'success' | 'error';
};

// Module-level FIFO chains, one per scope key: the tail promise of every
// call queued under the key. Module scope is deliberate — like TanStack
// Query's mutation scopes, the chain does not live on any component, so
// unmounting never abandons queued calls (they run to completion).
const scopeQueues = new Map<string, Promise<unknown>>();

// Appends `start` to the chain under `key` and returns its promise. The
// previous tail is awaited with its failure swallowed (`noop`): a queued
// call starts after the previous same-scope call SETTLES — success or
// failure — so one rejection never breaks the chain. `tail` mirrors `run`
// with the rejection stripped (the caller keeps owning it), and deletes
// the entry once it is still the tail — a newer queued call has already
// replaced the entry and owns the cleanup — so keys never accumulate.
const enqueueByScope = <T>(
  key: string,
  start: () => Promise<T>
): Promise<T> => {
  const run = (scopeQueues.get(key) ?? Promise.resolve())
    .catch(noop)
    .then(start);
  const tail = run.then(noop, noop);
  scopeQueues.set(key, tail);
  tail.then(() => {
    if (scopeQueues.get(key) === tail) scopeQueues.delete(key);
  });
  return run;
};

/**
 * Wrap a write function with mutation lifecycle tracking — the write-side
 * counterpart of `useRun`.
 *
 * The returned `mutate` is the injectable itself: stable identity, latest
 * closure, and the chain that `useOptimistic` / `useInvalidate` (or any
 * other wrapper) can also be registered on. The status reads the
 * injectable's shared stores — `isMutating` from the loading store,
 * `error` / `failureCount` (and the settle outcome behind `status`) from
 * the error store — so every consumer of the same mutation updates
 * together and components mounted after a call start from the shared
 * snapshot. `status` is the TanStack-style derived lifecycle
 * (`'idle' | 'pending' | 'success' | 'error'`) on the `isMutating` clock.
 *
 * Rejections keep flowing: `mutate` behaves like the original function, so
 * per-call callbacks are simply `.then` / `.catch` on the returned promise
 * — no separate per-call options API. Hook-level callbacks go through a
 * ref funnel: `options` may be a fresh inline object every render and the
 * latest closures still fire. `reset` clears the settled bookkeeping
 * without touching the ticket sequence: with no call in flight `status`
 * reads `'idle'` again, while an in-flight call keeps `pending` and its
 * outcome still lands after the reset.
 *
 * `invalidates` is the declarative mutation→query link: on success (only)
 * each target — a cache provider for its whole cache, or a
 * `[provider, ...argsPrefix]` tuple for prefix-matching entries — is
 * purged, exactly as `invalidate()` does. Mounted `useCache` consumers of
 * that provider refresh themselves through its deletion event, so the
 * mutation component needs no reference to any injectable — the provider
 * (usually a module constant) is all it takes.
 * A rejected mutation invalidates nothing.
 *
 * Division of labor: `useMutation` owns the lifecycle and status;
 * `useOptimistic` adds optimistic snapshots for locally predictable edits;
 * `invalidates` (or `useInvalidate` / `deletePrefix`) refreshes cached
 * reads — compose them on the same injectables. `scope` serializes
 * same-key calls (see {@link MutationOptions.scope}); it wraps the
 * lifecycle, so `onMutate` and a bound mutation's optimistic step run
 * when a queued call's turn comes, and each call's `invalidates` still
 * fires — in order — at its own success.
 *
 * @param {AsyncFunc} mutation - the write function to wrap; inline arrows
 *   are fine — `useInjectable` adopts the latest closure every render.
 * @param {MutationOptions} [options] - `onMutate` / `onSuccess` /
 *   `onError` / `onSettled` callbacks, `invalidates` cache targets and an
 *   optional `scope` serializing same-key calls; all optional.
 * @return {[M, MutationStatus, function]} `[mutate, status, reset]` —
 *   call `mutate` from event handlers; render `isMutating` or
 *   `status === 'pending'` on the submit button and `error` /
 *   `failureCount` for feedback UI; `reset` clears the failure
 *   bookkeeping between submissions.
 * @example
 * ```tsx
 * function RenameForm({id, name, fetchUsers}: Props) {
 *   const [rename, {isMutating, error}, reset] = useMutation(renameUser, {
 *     invalidates: [userCache],
 *     onError: () => toast('Save failed')
 *   });
 *   return (
 *     <form onSubmit={(e) => {
 *       e.preventDefault();
 *       reset();
 *       rename(id, name).catch(() => {});
 *     }}>
 *       {error && <p>{error.message}</p>}
 *       <button disabled={isMutating}>Save</button>
 *     </form>
 *   );
 * }
 * ```
 */
export function useMutation<
  M extends AsyncFunc,
  const T extends readonly unknown[] = readonly InvalidateTarget[]
>(
  mutation: M,
  options?: MutationOptions<M, T>
): [M, MutationStatus, () => void] {
  // 1. The injectable IS the returned `mutate`: stable identity across
  //    renders, and the wrapper chain the hooks below (plus
  //    useOptimistic/useInvalidate in consumers) register on.
  const mutate = useInjectable(mutation);

  // 2. Ref funnel for the callbacks: `options` is usually an inline object
  //    (new identity every render). One wrapper is registered ONCE on the
  //    chain and reads through the ref, so callbacks stay fresh without
  //    re-registering the wrapper or dragging options through effect deps.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Dev-only, fail fast: a non-provider target would otherwise only blow
  // up inside the success handler and turn a succeeded mutation into a
  // rejection. Throwing during render points at the component.
  if (process.env.NODE_ENV !== 'production' && options?.invalidates) {
    for (const target of options.invalidates) {
      const provider = Array.isArray(target) ? target[0] : target;
      if (!isCacheProvider(provider)) {
        throw new Error(
          'useMutation: invalidates expects cache providers (e.g. from ' +
            'createMemoryCacheProvider(), optionally as [provider, ...argsPrefix] ' +
            'tuples), got something else.'
        );
      }
    }
  }
  useInject(
    mutate,
    (f: M) =>
      ((...args: Parameters<M>) => {
        const {onMutate, onSuccess, onError, onSettled, invalidates} =
          optionsRef.current ?? {};
        onMutate?.(...args);
        return f(...args).then(
          (result) => {
            // Invalidation runs before the user callbacks: it is library
            // plumbing and must not be hostage to a throwing onSuccess.
            // Rejections never reach here — a failed mutation invalidates
            // nothing.
            if (invalidates) invalidate(invalidates as readonly any[]);
            onSuccess?.(result, ...args);
            onSettled?.(result, undefined, ...args);
            return result;
          },
          (e: any) => {
            onError?.(e, ...args);
            onSettled?.(undefined, e, ...args);
            // Rejections keep flowing: `mutate` behaves like the original
            // function, so awaiting callers can branch on the outcome.
            throw e;
          }
        );
      }) as M
  );

  // 2.5 The scope queue — registered between the loading store and the
  //     lifecycle wrapper, so the onion runs (outer→inner) loading →
  //     queue → lifecycle → fn. Two properties follow: the loading count
  //     rises the moment the call is MADE (a queued call is mutating
  //     while it waits), while everything below the queue — `onMutate`,
  //     a bound mutation's optimistic `update` step, the call itself —
  //     runs only when the call's turn comes, so same-scope writes never
  //     interleave. `scope` is read through the ref funnel, like the
  //     callbacks above.
  useInject(
    mutate,
    (f: M) =>
      ((...args: Parameters<M>) => {
        const {scope} = optionsRef.current ?? {};
        if (scope === undefined) return f(...args);
        let key: string | undefined;
        try {
          key = typeof scope === 'function' ? scope(...args) : scope;
        } catch {
          // A throwing scope resolver must not take the caller down with
          // it: run the call scope-less (parallel), exactly as before.
          return f(...args);
        }
        return key ? enqueueByScope(key, () => f(...args)) : f(...args);
      }) as M
  );

  // 3. Status from the shared stores — every flag is injectable-level
  //    state: sibling components tracking the same mutation update
  //    together, and late mounters start from the current values.
  //    These read the error store through the internal recorder, NOT the
  //    public `useError`/`useFailureCount`: the public hooks now claim
  //    errors (errors-as-state, rejection swallowed at the call boundary),
  //    and `mutate`'s contract keeps rejections flowing to the caller.
  //    Library-internal reads are not a user's declaration of ownership.
  const isMutating = useLoading(mutate);
  const errorStore = useErrorWrapper(mutate);
  const error = useStoreValue(
    errorStore,
    useCallback(() => errorStore.error, [errorStore])
  );
  const failureCount = useStoreValue(
    errorStore,
    useCallback(() => errorStore.failureCount, [errorStore])
  );
  // The settle outcome of the last applied emission — the signal that
  // separates "never called" from "last call succeeded" once `error` is
  // `undefined` (`lastOutcome === 'error'` is exactly `error !==
  // undefined`: every applied emission writes both in lockstep). Derived
  // on the isMutating clock, so status and isMutating can never disagree
  // about whether a call — queued or running — is outstanding.
  const lastOutcome = useStoreValue(
    errorStore,
    useCallback(() => errorStore.lastOutcome, [errorStore])
  );
  const status: MutationStatus['status'] = isMutating
    ? 'pending'
    : lastOutcome === 'success'
      ? 'success'
      : lastOutcome === 'error'
        ? 'error'
        : 'idle';

  // 4. Clear the settled error bookkeeping. resetError never touches the
  // ticket sequence, so an in-flight call's ticket stays valid and its
  // outcome still lands after the reset — reset only wipes what has
  // already settled (status included: it reads `idle` again).
  const reset = useCallback(() => {
    resetError(getErrorStore(mutate));
  }, [mutate]);

  return [mutate, {isMutating, error, failureCount, status}, reset];
}

// Base delay (ms) of the preset backoff strategies of useRetry.
const retryBaseDelay = 1000;

/**
 * Builds the `shouldRetry` callback of a preset useRetry configuration:
 * retry while `failureCount < retries`, waiting the backoff delay between
 * attempts (`exponential`: base·2^attempt, `linear`: base·(attempt+1),
 * or a custom `(attempt) => ms`). The wait reuses the existing
 * promise-based mechanism — returning a `Promise` from `shouldRetry`
 * delays the retry until it resolves.
 *
 * The preset delays of the named strategies carry ±25% jitter (a uniform
 * factor in `[0.75, 1.25]`, the same spread fetch-fun's `backoffDelay`
 * uses), so a fleet of clients retrying the same failing endpoint does
 * not sync up into a thundering herd. A custom `(attempt) => ms` backoff
 * owns its timing completely — including any jitter — and is passed
 * through untouched.
 *
 * The returned callback accepts the call's `AbortSignal` as an optional
 * third argument: while the sleep is armed, an abort settles it
 * immediately (`false`, timer cleared) instead of letting a cancelled
 * call wait out a delay whose retry will never happen.
 */
function presetShouldRetry(
  options: {
    retries?: number;
    backoff?: 'exponential' | 'linear' | ((attempt: number) => number);
  },
  retries = options.retries ?? 3,
  backoff = options.backoff ?? 'exponential'
): (
  failureCount: number,
  e: any,
  signal?: AbortSignal
) => boolean | Promise<any> {
  return (failureCount, e, signal) => {
    if (failureCount >= retries) return false;
    const base =
      typeof backoff === 'function'
        ? backoff(failureCount)
        : backoff === 'linear'
          ? retryBaseDelay * (failureCount + 1)
          : retryBaseDelay * 2 ** failureCount;
    // Only the named strategies are jittered — a custom backoff function
    // expresses its own timing by contract.
    const delay =
      typeof backoff === 'function'
        ? base
        : Math.round(base * (0.75 + Math.random() * 0.5));
    // A zero delay skips the timer entirely (also keeps tests fast).
    if (delay <= 0) return true;
    return new Promise<boolean>((resolve) => {
      // Abort-aware sleep: an aborted call settles the backoff right
      // away with `false` (retry verdict "no"), timer cleared, so the
      // useRetry loop terminates instead of idling through a delay for
      // an attempt nobody will consume. `timer` is declared before
      // `onAbort` references it — the abort listener is attached only
      // after the timeout exists, so the TDZ order is also the runtime
      // order, but the rule reads the declaration order.
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      }, delay);
      signal?.addEventListener('abort', onAbort, {once: true});
    });
  };
}

/**
 * Calls an asynchronous function with retry logic until a condition is met.
 *
 * Two signatures share one mechanism:
 *
 * - `useRetry(fn, shouldRetry)` — full control: retry while
 *   `shouldRetry(failureCount, e)` returns `true`; returning a `Promise`
 *   waits for it, then retries (that promise is how backoff is expressed).
 * - `useRetry(fn, options)` — the preset shorthand:
 *   `{retries?: number = 3, backoff?: 'exponential' | 'linear' |
 *   ((attempt: number) => number) = 'exponential'}` retries up to
 *   `retries` times after the initial failure, waiting between attempts
 *   (`'exponential'`: 1s, 2s, 4s…; `'linear'`: 1s, 2s, 3s…; a custom
 *   function receives the 0-based attempt index and returns the delay in
 *   ms). The named strategies jitter each delay by ±25% (a uniform factor
 *   in `[0.75, 1.25]`) so concurrent clients do not retry in lockstep;
 *   custom functions own their timing, jitter included.
 *
 * Cancellation: when the call was made with an `AbortSignal` — the
 * convention `useRun(fn, args, {signal: true})` establishes — aborting it
 * (unmount, dependency change) terminates the retry loop: the backoff
 * sleep settles immediately and no further attempt is issued. The final
 * rejection carries the last error, exactly like a `false` shouldRetry
 * verdict.
 *
 * @param {AF} injectableFn - The asynchronous function to call.
 * @param {(failureCount: number, e: any) => boolean | Promise<any>} shouldRetry - A function that determines whether to retry or not.
 * @return {void} This function does not return anything.
 * @example
 * ```tsx
 * const fetchFlaky = useInjectable(api.flaky);
 * // Up to 5 attempts (1 initial + 4 retries), jittered 1s/2s/4s/8s between them:
 * useRetry(fetchFlaky, {retries: 4});
 * // Custom backoff — passed through untouched, jitter included if you want it:
 * useRetry(fetchFlaky, {retries: 3, backoff: (n) => 500 * 2 ** n + Math.random() * 100});
 * // Aborting the driver stops the loop: no request leaves after the abort.
 * useRun(fetchFlaky, [id], {signal: true});
 * ```
 */
export function useRetry<AF extends AsyncFunc>(
  injectableFn: AF,
  shouldRetry: (failureCount: number, e: any) => boolean | Promise<any>
): void;
export function useRetry<AF extends AsyncFunc>(
  injectableFn: AF,
  options: {
    retries?: number;
    backoff?: 'exponential' | 'linear' | ((attempt: number) => number);
  }
): void;
export function useRetry<AF extends AsyncFunc>(
  injectableFn: AF,
  retry:
    | ((failureCount: number, e: any) => boolean | Promise<any>)
    | {
        retries?: number;
        backoff?: 'exponential' | 'linear' | ((attempt: number) => number);
      }
) {
  // The preset consumes the call's AbortSignal (abort-aware backoff); a
  // user callback with the documented two-parameter signature simply
  // ignores the extra argument.
  const shouldRetry: (
    failureCount: number,
    e: any,
    signal?: AbortSignal
  ) => boolean | Promise<any> =
    typeof retry === 'function' ? retry : presetShouldRetry(retry);
  useInject(
    injectableFn,
    (f: AF, callContext: any) =>
      ((...args: Parameters<AF>) => {
        // Cancellation discipline: a call whose driver aborted —
        // `useRun(..., {signal: true})` on unmount or dependency change —
        // must not keep issuing attempts; nobody is left to consume them.
        // The signal comes from the callContext the attachSignal bridge
        // maintains; when this layer sits OUTSIDE that bridge (registered
        // after useRun, so the bridge has not forwarded the call yet), a
        // trailing AbortSignal is duck-typed from the args themselves —
        // useRun appends it to the very tuple this wrapper receives.
        const last = args[args.length - 1];
        const signal = (callContext.signal ??
          (isAbortSignal(last) ? last : undefined)) as AbortSignal | undefined;
        const cancelled = () => signal?.aborted === true;
        let n = 0;
        const run = (): Promise<any> =>
          f(...args).catch((e: any) => {
            // An aborted call never retries: rejecting with the last
            // error keeps the same terminal semantics as a `false`
            // shouldRetry verdict.
            if (cancelled()) return Promise.reject(e);
            const r = shouldRetry(n++, e, signal);
            if (r instanceof Promise)
              // The preset's sleep is itself abort-aware; a custom
              // promise is guarded here instead — both kinds stop before
              // the next attempt once aborted.
              return r.then((again) =>
                again && !cancelled() ? run() : Promise.reject(e)
              );
            return r ? run() : Promise.reject(e);
          });
        return run();
      }) as AF
  );
}

/**
 * Injects a wrapper that counts in-flight calls on the shared loading store
 * of the injectable and returns that store.
 */
function useLoadingWrapper<AF extends AsyncFunc>(
  injectableFn: AF
): LoadingStore {
  const store = getLoadingStore(injectableFn);
  // Per-key in-flight mirror of the count above: keyed by the structural
  // args hash, so observers can ask "is THIS call running" instead of "is
  // anything running". The keyed store is created lazily here and only
  // consumed by the useArgsStatus-style hooks — plain useLoading callers
  // never pay for it beyond the wrapper's two calls below.
  const keyedStore = getKeyedStore(injectableFn);
  useInject(
    injectableFn,
    (f: AF) =>
      ((...args: Parameters<AF>) => {
        // Same key derivation as the read side (useArgsStatus): the
        // trailing AbortSignal appended by `useRun`'s `{signal: true}` is
        // trimmed, so a signal-driven call and a plain call of the same
        // logical args land on ONE slot.
        const key = stableHash(trimTrailingSignal(args));
        const release = beginKeyedCall(keyedStore, key);
        emitLoading(store, store.count + 1);
        return f(...args).finally(() => {
          release();
          emitLoading(store, store.count - 1);
        });
      }) as AF
  );
  return store;
}

/**
 * Creates a hook that manages loading state for an injectable async function.
 *
 * The in-flight count is kept on a store shared by every consumer of the
 * injectable, so the returned boolean is `true` while any call is in flight.
 *
 * @param {AsyncFunc} injectableFn - the async function to inject and track loading state for.
 * @returns {boolean} - The loading state of the injectable function.
 */
export function useLoading<AF extends AsyncFunc>(injectableFn: AF) {
  const store = useLoadingWrapper(injectableFn);
  // `count` is a plain number swapped in place by emitLoading, so it is a
  // naturally stable snapshot for useSyncExternalStore.
  const count = useStoreValue(
    store,
    useCallback(() => store.count, [store])
  );
  return count > 0;
}

/**
 * Returns `true` while a call is in flight and no result has been produced
 * yet — the initial loading of SWR semantics. Once any result exists (fresh
 * or cached), later background requests no longer count as initial loading.
 *
 * @param {AsyncFunc} injectableFn - the async function to watch.
 * @returns {boolean} - whether the first load is still pending.
 */
export function useInitialLoading<AF extends AsyncFunc>(injectableFn: AF) {
  const loadingStore = useLoadingWrapper(injectableFn);
  const resultStore = getResultStore(injectableFn);
  const count = useStoreValue(
    loadingStore,
    useCallback(() => loadingStore.count, [loadingStore])
  );
  // Booleans are stable snapshots; `hasResult` flips exactly once.
  const hasResult = useStoreValue(
    resultStore,
    useCallback(() => resultStore.hasResult, [resultStore])
  );
  return count > 0 && !hasResult;
}

/** What {@link useArgsStatus} returns for one args key. */
export type ArgsStatus<E = Error> = {
  /** `true` while a call with THESE args is in flight — sibling calls of
   * the same injectable with different args do not flip it. */
  loading: boolean;
  /**
   * The last error of THESE args; a later same-args success clears it.
   * Independent of the injectable-level `useError` broadcast. Typed by
   * the `E` type parameter (`Error` by default — no assertion needed at
   * the call site; narrow it for APIs rejecting richer errors via
   * `useArgsStatus<typeof fn, ApiError>`).
   */
  error: E | undefined;
  /** Failures of THESE args since their last success. */
  failureCount: number;
  /**
   * The shared last result while its provenance matches these args (the
   * displayed data was actually fetched with them), `undefined` otherwise
   * — `useResult`'s contract scoped to one key.
   */
  data: any | undefined;
  /**
   * `Date.now()` of the most recent successful settle of these args,
   * exposed under the same provenance contract as `data`: a number while
   * the displayed result was fetched with exactly these args,
   * `undefined` otherwise (including while a different args tuple's
   * result is on display). Failures never touch it, so it survives a
   * failed refetch of the same args. TanStack Query's `dataUpdatedAt`
   * analogue.
   */
  dataUpdatedAt?: number;
  /**
   * Successful settles of these args since they last took the display:
   * incremented on each same-args success, restarted at 1 when these args
   * (re)take the display after another tuple or a provenance-unknown
   * emission (optimistic snapshot, `useInfinite` pages) held it.
   * `undefined` exactly when `data` is. The cheap "displayed data has
   * updated" signal — TanStack Query's `dataUpdateCount` analogue.
   */
  dataUpdateCount?: number;
};

/**
 * Per-args observability of one injectable's calls — the keyed counterpart
 * of {@link useLoading} / {@link useError}.
 *
 * The injectable-level stores answer "is *anything* running / what did the
 * *latest* call fail with", which is right for a single-args screen but
 * wrong when one injectable serves several argument sets at once: two
 * concurrent calls overwrite each other's flag and error. This hook keys
 * the bookkeeping by the structural args hash ({@link stableHash}, with a
 * trailing `AbortSignal` collapsed exactly like `usePlaceholderData`), so
 * each args tuple gets its own `loading` / `error` / `failureCount` slots
 * that no sibling call can clobber.
 *
 * The keyed slots ride the SAME wrapper chain as the injectable-level
 * stores — `useArgsStatus` registers nothing on the chain itself, so
 * observability never changes call semantics, and consumers unmounting
 * cannot break a call's bookkeeping (the wrapper owns start/end pairing;
 * each key's slot is deleted when its last in-flight call drains).
 *
 * `data` mirrors `useResult`'s contract scoped to these args: the shared
 * last result while its provenance matches (the displayed data was
 * actually fetched with these args), `undefined` otherwise — including
 * while a DIFFERENT args tuple's result is on display. `dataUpdatedAt`
 * and `dataUpdateCount` ride the same contract: the settle timestamp
 * (`Date.now()`) and the successive-update count of the displayed args'
 * data — both `undefined` whenever `data` is, and untouched by failures
 * (a failed refetch of the same args leaves the last success stamped).
 *
 * `error` is typed `Error | undefined` by default (no assertion needed at
 * the call site). The `E` type parameter narrows it for APIs that reject
 * with richer error shapes: `useArgsStatus<typeof fetchUser, ApiError>`
 * reports `ApiError | undefined`. Like `useError`'s type parameter it is
 * a declaration, not an inference — the runtime slot holds whatever the
 * call actually rejected with.
 *
 * @param injectableFn the injectable to observe
 * @param args the args tuple identifying the call slot
 * @returns `{loading, error, failureCount, data, dataUpdatedAt, dataUpdateCount}` for exactly these args
 * @example
 * ```tsx
 * function Row({id}: {id: number}) {
 *   const {loading, error, data} = useArgsStatus(fetchUser, [id]);
 *   // Row A (id=1) shows its own spinner even while Row B (id=2) runs —
 *   // and an id=1 failure never shows on Row B.
 *   return <li>{loading ? '…' : error ? `failed` : data?.name}</li>;
 * }
 * ```
 */
export function useArgsStatus<AF extends AsyncFunc, E = Error>(
  injectableFn: AF,
  args: Parameters<AF>
): ArgsStatus<E> {
  // Mounting this hook claims the instance's errors, exactly like
  // `useError`/`useFailureCount`: the keyed failure reads declare
  // ownership, so the instance's calls stop rejecting at the boundary.
  useSwallowCell(injectableFn);
  const loadingStore = useLoadingWrapper(injectableFn);
  const errorStore = useErrorWrapper(injectableFn);
  // The scoped `data` read needs results to flow with provenance: this hook
  // is part of the read stack (like useResult), so it registers the result
  // emitter itself. A consumer that ALSO calls useResult just adds a second
  // emitter instance — same store, seq-guarded, no semantic change.
  const resultStore = useEmittingResultStore(injectableFn);
  const keyedStore = getKeyedStore(injectableFn);
  const argsKey = stableHash(trimTrailingSignal(args));
  // One subscription on the keyed version counter drives all three keyed
  // reads: every keyed mutation bumps `version`, and useSyncExternalStore
  // re-reads the snapshot afterwards, so each getter below observes the
  // post-mutation state.
  useStoreValue(
    keyedStore,
    useCallback(() => keyedStore.version, [keyedStore])
  );
  // The result store is a separate broadcast surface (provenance changes
  // without a keyed event), so it gets its own subscription.
  useStoreValue(
    resultStore,
    useCallback(() => resultStore.version, [resultStore])
  );
  const slot = keyedStore.keyed.get(argsKey);
  // Provenance match against the store's own stamped key — the write side
  // (emitResult) maintains `lastKey` in lockstep with `lastResult`, so the
  // data-scoped reads below all gate on one comparison instead of
  // re-hashing `lastArgs` per field.
  const dataMatches = resultStore.hasResult && resultStore.lastKey === argsKey;
  return {
    loading: slot ? slot.count > 0 : false,
    error: slot ? slot.error : undefined,
    failureCount: slot ? slot.failureCount : 0,
    data: dataMatches ? resultStore.lastResult : undefined,
    dataUpdatedAt: dataMatches ? resultStore.updatedAt : undefined,
    dataUpdateCount: dataMatches ? resultStore.updateCount : undefined
  };
}

/**
 * Strips the trailing parameter of a signature — the slot occupied by the
 * `AbortSignal` appended when `useRun` runs with `{signal: true}`.
 */
type WithoutSignal<P extends any[]> = P extends [...infer Head, any]
  ? Head
  : [];

// Bridge for the per-call context: when the last argument of a call is an
// AbortSignal, it is exposed as `signal` on the callContext so deeper
// wrappers can observe cancellation.
const attachSignal = <F extends Func>(f: F, callContext: any): F =>
  ((...args: Parameters<F>) => {
    const last = args[args.length - 1];
    // Duck-typed detection: a signal created in another realm (iframe,
    // separate test environment) does not satisfy `instanceof` here.
    if (isAbortSignal(last)) callContext.signal = last;
    return f(...args);
  }) as F;

// In-flight registry of useRun-driven calls, keyed by the injectable
// itself plus the keyed store's args derivation (`stableHash` of the tuple
// with a trailing signal trimmed): concurrent runs of one injectable with
// the same logical args share a single request — TanStack Query's default
// request deduplication for the path no cache provider covers (`useCache`
// already folds concurrent same-key reads through the provider's `load`
// slot; with both, this registry short-circuits one chain traversal
// earlier and changes nothing observable). Plain (non-injectable)
// functions are exempt: they own no shared stores, so two runs are two
// side effects by design.
//
// Lifecycle: an entry dies with its promise — a settled call is never
// shared, so the next call fetches and a failed call can be retried. A
// run created with `{signal: true}` vacates its entry from the signal's
// abort listener SYNCHRONOUSLY, mirroring the memory provider's load-slot
// abort-yield: a same-stack successor (StrictMode's mount→cleanup→mount,
// an unmount-then-remount commit) starts a fresh request instead of
// joining a dead promise. A joiner's own abort never touches the entry —
// its signal never reached the fetch (the creator's did) — and a joiner
// that skipped its call keeps the shared outcome to settlement through
// the injectable's stores.
const runInflight = new WeakMap<Func, Map<string, Promise<any>>>();

function runInflightOf(fn: Func): Map<string, Promise<any>> {
  let map = runInflight.get(fn);
  if (!map) {
    map = new Map();
    runInflight.set(fn, map);
  }
  return map;
}

// Registers a run's promise under its key. `settle` is the exact undo in
// both roles: as the promise's settle handler it drops the entry
// (identity-guarded against a newer entry already replacing this one),
// and as the signal's abort listener it vacates the entry synchronously.
// The settle handler also observes a rejection, so a failed no-cache run
// no longer surfaces as an unhandled rejection once `useRun`'s void call
// discards the promise.
function trackRun(
  inflight: Map<string, Promise<any>> | undefined,
  key: string | undefined,
  promise: Promise<any>,
  signal?: AbortSignal
) {
  if (!inflight || key === undefined) return;
  inflight.set(key, promise);
  const settle = () => {
    if (signal && !signal.aborted) signal.removeEventListener('abort', settle);
    if (inflight.get(key) === promise) inflight.delete(key);
  };
  if (signal) signal.addEventListener('abort', settle, {once: true});
  promise.then(settle, settle);
}

/**
 * Runs a function and updates its effects whenever its dependencies change.
 *
 * With `{signal: true}`, each run creates an `AbortController` and passes
 * its signal to the function as an additional trailing argument; the signal
 * is aborted when the dependencies change or the component unmounts. On an
 * injectable, the signal is also exposed as `signal` on the per-call
 * context seen by the injected wrappers. Plain (non-`useInjectable`)
 * functions are detected via `isInjectable` and run without the bridge.
 *
 * Concurrent runs of one injectable with the same logical args — two
 * mounted components, or one component and StrictMode's double effect —
 * share the in-flight request: the first run creates it, the later runs
 * join it and start nothing (the shared stores already serve them both).
 * A run whose promise settled is never shared; a `{signal: true}` run
 * whose signal aborted yields its place synchronously, so a same-stack
 * successor starts fresh. On injectables this matches TanStack Query's
 * default request deduplication; plain functions keep one-run-one-call.
 *
 * By default the effect re-runs whenever an argument changes by reference,
 * so callers passing fresh object/array literals on every render (e.g.
 * `useRun(fn, [{page, filters}])`) would re-run on each render. The `hash`
 * option swaps the reference comparison for a key computed from the
 * arguments: the effect re-runs only when the key changes, matching the
 * structural semantics of `createMemoryCacheProvider` keys.
 *
 * @param {F} fn - The function to run.
 * @param {Parameters<F>} args - The arguments to pass to the function.
 * @param {object} [options] - `signal` (default `false`): append an
 *   `AbortSignal` argument and abort it on cleanup. `hash`: computes the
 *   effect dependency key from the call arguments; when provided, the
 *   individual arguments no longer participate in the dependencies by
 *   reference — a rerun happens only when the computed key changes. Use
 *   {@link stableHash} (exported from the entry) for structural comparison.
 * @example
 * ```tsx
 * const fetchPage = useInjectable(
 *   (query: {page: number; filters: string[]}) => fetchUsers(query)
 * );
 * // New `{page, filters}` literal every render, but the effect only
 * // re-runs when the structure actually changes (same hash → no rerun).
 * useRun(fetchPage, [{page, filters}], {hash: stableHash});
 * ```
 */
export function useRun<F extends Func>(fn: F, args: Parameters<F>): void;
export function useRun<F extends Func>(
  fn: F,
  // The trailing slot is only reserved when `signal: true` appends one, so
  // hash-only (or `signal: false`) calls pass the full argument tuple.
  args: Parameters<F> | WithoutSignal<Parameters<F>>,
  options: {signal?: boolean; hash?: (args: any[]) => string}
): void;
export function useRun<F extends Func>(
  fn: F,
  args: any[],
  options?: {signal?: boolean; hash?: (args: any[]) => string}
) {
  const {signal = false, hash} = options ?? {};
  // Dev-only inline-args warning. Without `hash`, the raw argument
  // references live in the effect dependencies, so an inline object/array
  // literal in `args` re-runs the effect on every render even when the
  // structure never changed. The check remembers the previous render's
  // args by reference and by stableHash: a changed reference with an
  // unchanged hash is exactly that footgun.
  //
  // The `process.env.NODE_ENV !== 'production'` guard is what React
  // itself ships: every bundler replaces that member expression
  // statically (Vite/webpack, dev and prod builds alike), so the whole
  // block — the stableHash computation included — is dead-code-eliminated
  // from production bundles. It is deliberately NOT `import.meta.env`:
  // this package typechecks under `module: NodeNext` without
  // `"type": "module"`, where any `import.meta` usage is a compile error.
  // The ref hook itself runs unconditionally to keep the hook order
  // identical in both modes.
  const prevArgsRef = useRef<{args: any[]; hash: string} | undefined>(
    undefined
  );
  if (!hash && process.env.NODE_ENV !== 'production') {
    const prev = prevArgsRef.current;
    const key = stableHash(args);
    if (prev && prev.args !== args && prev.hash === key) {
      // eslint-disable-next-line no-console -- the dev warning IS the feature
      console.warn(
        'useRun: the args reference changed but stableHash(args) is unchanged — ' +
          'the effect will re-run on every render. Pass {hash: stableHash} ' +
          'to compare the args structurally instead.'
      );
    }
    prevArgsRef.current = {args, hash: key};
  }
  // Register the AbortSignal → callContext bridge. `useRun` also accepts
  // plain (non-`useInjectable`) functions; `isInjectable` probes for that
  // up front instead of relying on `useInject` throwing before consuming
  // any React hooks, so the bridge registration is explicit and the hook
  // order stays stable across renders.
  if (isInjectable(fn)) useInject(fn, attachSignal);
  // With `hash`, the args no longer live in the effect dependencies, so the
  // latest ones are funneled through a ref: a hash change re-runs the effect
  // with the args of the render that produced the new hash, while an
  // unchanged hash skips the rerun entirely. The ref is kept on the no-hash
  // path too — its dependencies still gate the rerun by reference, and one
  // uniform read path beats two diverging ones.
  const argsRef = useRef(args);
  argsRef.current = args;
  const hashKey = hash ? hash(args) : undefined;
  useEffect(
    () => {
      const currentArgs = argsRef.current;
      // Concurrent same-args sharing, see the registry above. The joiner
      // starts nothing and aborts nothing: the creator's chain drives the
      // shared stores for both, and the joiner's cleanup has no signal on
      // the wire to abort. `isInjectable` is stable per fn identity, so
      // the conditional stays render-stable.
      const inflight = isInjectable(fn) ? runInflightOf(fn) : undefined;
      const key =
        inflight && stableHash(trimTrailingSignal(currentArgs as any[]));
      if (inflight && key !== undefined && inflight.get(key)) return;
      if (!signal) {
        trackRun(inflight, key, Promise.resolve(fn(...currentArgs)));
        return;
      }
      const ac = new AbortController();
      trackRun(
        inflight,
        key,
        Promise.resolve((fn as Func)(...currentArgs, ac.signal)),
        ac.signal
      );
      return () => ac.abort();
      // Without `hash`, the call arguments participate in the dependencies by
      // reference (existing semantics); with `hash`, the computed key replaces
      // them. In both cases only the destructured `signal` flag (not the whole
      // options object) is included.
    },
    hash ? [hashKey, signal] : [...args, signal]
  );
}

/**
 * A custom hook that returns a stable refresh callback for the current
 * `args` of a cached injectable: calling it deletes the cache entry under
 * those args and immediately re-runs the injectable with them — a forced
 * fresh fetch that bypasses both the settled cache and any in-flight
 * request (the entry — in-flight `load` slot included — is deleted first,
 * so the refresh can never be folded back into the very request it
 * replaces).
 *
 * Key linkage with `useRun({signal: true})`: a run stores its entry under
 * the args tuple WITH the trailing `AbortSignal` appended. The delete
 * addresses both shapes — the plain tuple and its trailing-signal twin
 * (`stableHash` collapses every signal instance to one placeholder, so
 * appending a fresh signal addresses the run's key; providers hashing with
 * a signal-stripping custom hash normalize both deletes to one) — so the
 * entry a run wrote is always hit, with no manual argument stripping at
 * the call site.
 *
 * The returned callback is referentially stable for the hook's lifetime
 * (across renders AND `args` changes — it always refreshes the newest
 * render's args), the revalidation-slot claim suppresses the double fetch
 * our own deletion event would otherwise trigger in mounted `useCache`
 * consumers, and the returned promise never rejects: failures resolve
 * `undefined` and surface through `useError`/`useArgsStatus` instead —
 * fire-and-forget call sites (`onClick={() => refresh()}`) are safe as-is.
 *
 * @param {AsyncFunc} injectableFn - the injectable to refresh.
 * @param {any[]} args - the logical arguments to refresh (the same tuple
 *   passed to `useRun` — with or without its trailing signal slot).
 * @param {CacheProvider} cacheProvider - the same cache provider passed to
 *   `useCache`.
 * @return {function} a stable `() => Promise<R | undefined>` that deletes
 *   the entry under the current args, then re-runs the injectable.
 * @example
 * ```tsx
 * const fetchUser = useInjectable(getUser);
 * useCache(fetchUser, userCache);
 * const refresh = useRefresh(fetchUser, [userId], userCache);
 * useRun(fetchUser, [userId], {signal: true});
 *
 * <button type='button' onClick={() => refresh()}>Refresh</button>
 * // entry gone → hard miss → one fresh request, subscribers re-broadcast
 * ```
 */
export function useRefresh<AF extends AsyncFunc>(
  injectableFn: AF,
  args: Parameters<AF> | WithoutSignal<Parameters<AF>>,
  cacheProvider: CacheProvider<R<AF>, Parameters<AF>>
): () => Promise<R<AF> | undefined> {
  // Latest-args funnel (the useRun pattern): the callback stays
  // referentially stable across renders and args changes alike, and always
  // refreshes the args of the newest render — no dependency on the args
  // identity, so inline object literals cost nothing.
  const argsRef = useRef(args as any[]);
  argsRef.current = args as any[];
  return useCallback(() => {
    const currentArgs = argsRef.current;
    // Claim the revalidation slot BEFORE deleting (the useInvalidate
    // pattern): our own deletion event would otherwise make mounted
    // useCache consumers re-run the same args and fetch a second time.
    // Both addressings are claimed because the deletion event carries the
    // entry's raw tuple — written with or without a trailing signal.
    //
    // ALL claims land before ANY delete — a custom signal-stripping
    // provider `hash` makes the FIRST delete (the plain tuple) hit the
    // entry a `useRun({signal: true})` call wrote, so the event fires
    // mid-loop with the `#sig`-shaped raw tuple while only the plain key
    // had been claimed. The consumer re-run then joined our own re-fetch
    // through the provider's in-flight dedupe: one fetch, two
    // wrapper-chain settles — one failed refetch tallied a doubled
    // failureCount. Two phases close the window for every claim/delete
    // pairing; the default hash is unaffected either way (its first
    // delete misses the signalled entry, so its event only fired after
    // both claims were in place).
    const pending = getPendingSet(injectableFn, cacheProvider);
    const signalled = [...currentArgs, new AbortController().signal];
    const tuples = [currentArgs, signalled] as Parameters<AF>[];
    for (const tuple of tuples) pending.add(stableHash(tuple));
    for (const tuple of tuples) cacheProvider.delete(tuple);
    return Promise.resolve(injectableFn(...(currentArgs as Parameters<AF>)))
      .catch(noop)
      .finally(() => {
        for (const tuple of tuples) {
          pending.delete(stableHash(tuple));
        }
      });
  }, [injectableFn, cacheProvider]);
}

export {
  usePolling,
  useFocusRevalidate,
  useReconnectRevalidate
} from './polling';

export {useInjectable, createMemoryCacheProvider};
export {default as createMutationBinder} from '../mutation';
export type {
  MutationSpec,
  BoundMutation,
  CreateMutationBinder,
  PersistOptions
} from '@@/types';
export {stableHash, isAbortSignal, stripVolatile} from '@@/util';
