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
  isInjectable
} from './inject';
import {
  ErrorStore,
  LoadingStore,
  ResultStore,
  currentErrorSeq,
  emitError,
  emitLoading,
  emitResult,
  emitStale,
  getErrorStore,
  getLoadingStore,
  getResultStore,
  getStaleStore,
  nextErrorSeq,
  nextResultSeq,
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
import createMemoryCacheProvider from './memory-cache-provider';

export {useInject, useInjectBefore, getInjectContext, isInjectable};
export type {
  AsyncFunc,
  Func,
  R,
  CacheProvider,
  CacheResult,
  CacheEvent
} from '@@/types';

export {useDedup} from './dedup';
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

// Drops the trailing AbortSignal slot of an args tuple. `useRun` with
// `{signal: true}` appends the signal AFTER the caller's logical
// arguments, and stableHash already collapses every signal instance to one
// fixed placeholder — so trimming the extra slot makes tuples with and
// without an appended signal hash identically.
const trimTrailingSignal = (args: readonly any[]) =>
  args.length > 0 && isAbortSignal(args[args.length - 1])
    ? args.slice(0, -1)
    : args;

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

type SuspenseSlot = {promise: Promise<any> | undefined};

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

// Suspends until the shared result store publishes anything: the listener
// removes itself on the first result, so an abandoned suspension (e.g. the
// boundary unmounted before any call settled) never leaks. Used when no
// in-flight promise has been recorded yet — the fetch has simply not been
// started, e.g. it is driven from outside the suspended subtree or starts
// later in the same render pass.
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
 * suspended subtree (or the call must be started before/elsewhere). Once
 * the first result has arrived, every later result flows in through the
 * shared result store exactly like `useResult`.
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
 * `stale` is shared state too, just like the result: every `useCache`
 * consumer of the same injectable reads one broadcast flag and updates
 * together, with the last staleness verdict of any registered wrapper
 * winning. Each consumer still registers its own wrapper, so a call still
 * performs the cache lookup once per consumer.
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
  const staleStore = getStaleStore(injectableFn);
  // This consumer's own seen-set: every args tuple its wrapper below has
  // fetched, structurally keyed with the latest raw tuple winning. It is
  // hook-local state, dropped on unmount, so a departed consumer's queries
  // are never re-run by a later purge of the provider.
  const seenRef = useRef<Map<string, any[]>>(undefined);
  if (!seenRef.current) seenRef.current = new Map();
  const seen = seenRef.current;
  // The boolean snapshot is stable by nature, so unchanged emissions bail
  // out of re-renders exactly like the old local setState did.
  const stale = useStoreValue(
    staleStore,
    useCallback(() => staleStore.stale, [staleStore])
  );

  useEffect(cacheProvider.use, []);

  // GC exemption while mounted: the tuples this consumer has fetched stay
  // observed for as long as it is on screen, so the provider's per-entry
  // sweep never reaps an entry someone is watching (TanStack Query keeps a
  // query with observers alive the same way). A tail wrapper — registered
  // during render like every hook of the chain — marks each call's tuple
  // both on the provider (the GC exemption) and in the injectable's
  // observed-set (so passive revalidation can tell a GC deletion of a live
  // entry from a real invalidation); the effect below catches up with
  // pre-existing tuples and unmarks everything on unmount, handing the
  // entries back to the provider's GC clock. Providers without the
  // optional `observe` member simply skip this — the sweep stays args-blind
  // for them.
  const observe = cacheProvider.observe;
  const observedSet = getObservedSet(injectableFn, cacheProvider);
  useInject(
    injectableFn,
    (f: AF) => {
      if (!observe) return f;
      return ((...callArgs: Parameters<AF>) => {
        observe([callArgs], true);
        observedSet.add(stableHash(callArgs));
        return f(...callArgs);
      }) as AF;
    }
  );
  useEffect(() => {
    if (!observe) return;
    // Catch up with anything fetched before this effect ran (the wrapper
    // only sees calls made after its registration).
    const tuples = [...seen.values()] as Parameters<AF>[];
    observe(tuples, true);
    for (const tuple of tuples) observedSet.add(stableHash(tuple));
    return () => {
      observe([...seen.values()] as Parameters<AF>[], false);
      observedSet.clear();
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
        seen.set(stableHash(args), args);
        const seq = nextResultSeq(store);
        const refetch = () => {
          const publish = thru<R<AF>>((r) => {
            // With a load-capable provider the settle write-back belongs to
            // the provider itself (generation-guarded against writes that
            // landed mid-flight); the legacy path keeps its write-through.
            if (!cacheProvider.load) cacheProvider.set(args, r);
            emitResult(store, r, seq, args);
            emitStale(staleStore, false);
          });
          // Routing through `load` shares ONE in-flight promise across every
          // consumer of these args — and every other channel using the same
          // provider (another component's injectable, a router loader) —
          // with the factory, i.e. the whole inner wrapper chain including
          // any useRetry loop, running exactly once.
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
            emitStale(staleStore, isStale);
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
      const pending = getPendingSet(injectableFn, cacheProvider);
      const key = stableHash(args);
      pending.add(key);
      cacheProvider.delete(args);
      const call = injectableFn(...args) as Promise<R<AF>>;
      call.finally(() => pending.delete(key));
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
  useInject(
    injectableFn,
    (f: AF) =>
      ((...args) => {
        const seq = nextErrorSeq(store);
        return f(...args)
          .then(thru(() => emitError(store, undefined, seq)))
          .catch(thruError((e: any) => emitError(store, e, seq)));
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
 * `error` / `failureCount` from the error store — so every consumer of
 * the same mutation updates together and components mounted after a call
 * start from the shared snapshot.
 *
 * Rejections keep flowing: `mutate` behaves like the original function, so
 * per-call callbacks are simply `.then` / `.catch` on the returned promise
 * — no separate per-call options API. Hook-level callbacks go through a
 * ref funnel: `options` may be a fresh inline object every render and the
 * latest closures still fire. `reset` writes a success-shaped clearance
 * without raising the seq watermark, so a call already in flight still
 * lands afterwards — reset only wipes what has already settled.
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
 *   call `mutate` from event handlers; render `isMutating` on the submit
 *   button and `error` / `failureCount` for feedback UI; `reset` clears
 *   the failure bookkeeping between submissions.
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
  const isMutating = useLoading(mutate);
  const error = useError(mutate);
  const failureCount = useFailureCount(mutate);

  // 4. Clear the settled error bookkeeping. Writing with the CURRENT seq
  //    does not raise the watermark, so an in-flight call's ticket stays
  //    valid and its outcome still lands after the reset.
  const reset = useCallback(() => {
    const store = getErrorStore(mutate);
    emitError(store, undefined, currentErrorSeq(store));
  }, [mutate]);

  return [mutate, {isMutating, error, failureCount}, reset];
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
 */
function presetShouldRetry(
  options: {
    retries?: number;
    backoff?: 'exponential' | 'linear' | ((attempt: number) => number);
  },
  retries = options.retries ?? 3,
  backoff = options.backoff ?? 'exponential'
): (failureCount: number, e: any) => boolean | Promise<any> {
  return (failureCount, e) => {
    if (failureCount >= retries) return false;
    const delay =
      typeof backoff === 'function'
        ? backoff(failureCount)
        : backoff === 'linear'
          ? retryBaseDelay * (failureCount + 1)
          : retryBaseDelay * 2 ** failureCount;
    // A zero delay skips the timer entirely (also keeps tests fast).
    if (delay <= 0) return true;
    return new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(true), delay)
    );
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
 *   ms).
 *
 * @param {AF} injectableFn - The asynchronous function to call.
 * @param {(failureCount: number, e: any) => boolean | Promise<any>} shouldRetry - A function that determines whether to retry or not.
 * @return {void} This function does not return anything.
 * @example
 * ```tsx
 * const fetchFlaky = useInjectable(api.flaky);
 * // Up to 5 attempts (1 initial + 4 retries), 1s/2s/4s/8s between them:
 * useRetry(fetchFlaky, {retries: 4});
 * // Custom jittered backoff:
 * useRetry(fetchFlaky, {retries: 3, backoff: (n) => 500 * 2 ** n + Math.random() * 100});
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
  const shouldRetry =
    typeof retry === 'function' ? retry : presetShouldRetry(retry);
  useInject(
    injectableFn,
    (f: AF) =>
      ((...args: Parameters<AF>) => {
        let n = 0;
        const run = (): Promise<any> =>
          f(...args).catch((e: any) => {
            const r = shouldRetry(n++, e);
            if (r instanceof Promise) return r.then(run);
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
  useInject(
    injectableFn,
    (f: AF) =>
      ((...args: Parameters<AF>) => {
        emitLoading(store, store.count + 1);
        return f(...args).finally(() => emitLoading(store, store.count - 1));
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
 * By default the effect re-runs whenever an argument changes by reference,
 * so callers passing fresh object/array literals on every render (e.g.
 * `useRun(fn, [{page, filters}])`) would re-run on each render. The `hash`
 * option swaps the reference comparison for a key computed from the
 * arguments: the effect re-runs only when the key changes, matching the
 * structural semantics of `useDedup` and `createMemoryCacheProvider`.
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
      if (!signal) {
        void fn(...currentArgs);
        return;
      }
      const ac = new AbortController();
      void (fn as Func)(...currentArgs, ac.signal);
      return () => ac.abort();
      // Without `hash`, the call arguments participate in the dependencies by
      // reference (existing semantics); with `hash`, the computed key replaces
      // them. In both cases only the destructured `signal` flag (not the whole
      // options object) is included.
    },
    hash ? [hashKey, signal] : [...args, signal]
  );
}

export {
  usePolling,
  useFocusRevalidate,
  useReconnectRevalidate
} from './polling';

export {useInjectable, createMemoryCacheProvider};
export {default as createMutationBinder} from './mutation';
export type {MutationSpec, BoundMutation, CreateMutationBinder} from '@@/types';
export {stableHash, isAbortSignal} from '@@/util';
