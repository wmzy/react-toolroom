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
import {isAbortSignal, noop, thru, thruError} from '@@/util';
import {
  useInject,
  useInjectBefore,
  useInjectable,
  getInjectContext,
  isInjectable
} from './inject';
import {
  LoadingStore,
  ResultStore,
  emitLoading,
  emitResult,
  emitStale,
  getLoadingStore,
  getResultStore,
  getStaleStore,
  nextResultSeq,
  useStoreValue
} from './base';
import createMemoryCacheProvider from './memory-cache-provider';

export {useInject, useInjectBefore, getInjectContext, isInjectable};
export type {AsyncFunc, Func, R, CacheProvider, CacheResult} from '@@/types';

export {useDedup} from './dedup';

export {subscribeInjectEvents} from './devtools';

/**
 * Get the result of a wrapped async function. Results are broadcast through
 * a store shared by every consumer of the same injectable, so all subscribed
 * components update together, and components mounting after a call resolved
 * start from the shared last result.
 * @param injectableFn the wrapped async function
 * @param [init] the initial value, used until any result has arrived
 * @returns the result
 */
export function useResult<AF extends AsyncFunc>(
  injectableFn: AF
): R<AF> | undefined;
export function useResult<AF extends AsyncFunc>(
  injectableFn: AF,
  init: R<AF>
): R<AF>;
export function useResult<AF extends AsyncFunc>(
  injectableFn: AF,
  init?: R<AF>
): R<AF> | undefined {
  type RAF = R<AF>;
  const store = getResultStore(injectableFn);
  // `init` only applies to the first frame and is captured once, so later
  // changes to the prop never leak into an ongoing render stream.
  const [initial] = useState<RAF | undefined>(() =>
    store.hasResult ? store.lastResult : init
  );
  // Late subscribers start from the shared last result instead of `init`,
  // so they render data immediately without re-running the request.
  const result = useStoreValue(
    store,
    useCallback(
      () => (store.hasResult ? store.lastResult : initial),
      [store, initial]
    )
  );

  useInject(
    injectableFn,
    (f: AF) =>
      ((...args) => {
        const seq = nextResultSeq(store);
        return f(...args).then(thru<RAF>((r) => emitResult(store, r, seq)));
      }) as AF
  );
  return result;
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
          thru<R<AF>>((r) => emitResult(store, r, seq))
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
 * @param {AsyncFunc} injectableFn - the asynchronous function to memoize
 * @param {CacheProvider} cacheProvider - the cache provider for the function results
 * @param {number} staleTime - the time in milliseconds after which the cached result is considered stale
 * @return {boolean} a boolean indicating whether the cached result is stale or not
 */
export function useCache<AF extends AsyncFunc>(
  injectableFn: AF,
  cacheProvider: CacheProvider<R<AF>, any[]>,
  staleTime = 0
) {
  const store = getResultStore(injectableFn);
  const staleStore = getStaleStore(injectableFn);
  // The boolean snapshot is stable by nature, so unchanged emissions bail
  // out of re-renders exactly like the old local setState did.
  const stale = useStoreValue(
    staleStore,
    useCallback(() => staleStore.stale, [staleStore])
  );

  useEffect(cacheProvider.use, []);

  useInject(
    injectableFn,
    (f: AF) =>
      ((...args) => {
        const seq = nextResultSeq(store);
        const refetch = () =>
          f(...args).then(
            thru<R<AF>>((r) => {
              cacheProvider.set(args, r);
              emitResult(store, r, seq);
              emitStale(staleStore, false);
            })
          );
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
            // renders it without waiting for the network.
            emitResult(store, data, seq);
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
  cacheProvider: CacheProvider<R<AF>, any[]>
): (...args: Parameters<AF>) => Promise<R<AF>> {
  return useCallback(
    (...args: Parameters<AF>) => {
      cacheProvider.delete(args);
      return injectableFn(...args) as Promise<R<AF>>;
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
 * A hook that accepts an async function and returns any errors thrown.
 *
 * @param {AsyncFunc} injectableFn - The async function to be executed.
 * @return {Error} The error thrown by the async function.
 */
export function useError<AF extends AsyncFunc, E extends Error>(
  injectableFn: AF
) {
  const [error, setError] = useState<E>();
  useInject(
    injectableFn,
    (f: AF) =>
      ((...args) =>
        f(...args)
          .then(thru(() => setError(undefined)))
          .catch(thruError<E>(setError))) as AF
  );
  return error;
}

/**
 * Returns a count of the number of times the provided async function has failed.
 *
 * @param {AF} injectableFn - the async function to inject and count failures of
 * @return {number} the count of failures
 */
export function useFailureCount<AF extends AsyncFunc>(injectableFn: AF) {
  const [count, setCount] = useState(0);
  useInject(
    injectableFn,
    (f: AF) =>
      ((...args) =>
        f(...args)
          .then(thru(() => setCount(0)))
          .catch(thruError(() => setCount((n) => n + 1)))) as AF
  );
  return count;
}

/**
 * Calls an asynchronous function with retry logic until a condition is met.
 *
 * @param {AsyncFunc} injectableFn - The asynchronous function to call.
 * @param {(failureCount: number, e: any) => boolean | Promise<any>} shouldRetry - A function that determines whether to retry or not.
 * @return {void} This function does not return anything.
 */
export function useRetry<AF extends AsyncFunc>(
  injectableFn: AF,
  shouldRetry: (failureCount: number, e: any) => boolean | Promise<any>
) {
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

export {usePolling, useFocusRevalidate} from './polling';

export {useInjectable, createMemoryCacheProvider};
export {stableHash, isAbortSignal} from '@@/util';
