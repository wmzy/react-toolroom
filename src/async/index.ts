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
import {useCallback, useEffect, useState} from 'react';
import {noop, thru, thruError} from '@@/util';
import {
  useInject,
  useInjectBefore,
  useInjectable,
  getInjectContext
} from './inject';
import {
  LoadingStore,
  emitLoading,
  emitResult,
  getLoadingStore,
  getResultStore,
  nextResultSeq,
  useBroadcast
} from './base';
import createMemoryCacheProvider from './memory-cache-provider';

export {useInject, useInjectBefore, getInjectContext};

export {useDedup} from './dedup';

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
  // Late subscribers start from the shared last result instead of `init`,
  // so they render data immediately without re-running the request.
  const [result, setResult] = useState<RAF | undefined>(() =>
    store.hasResult ? store.lastResult : init
  );
  // `setResult` is stable across renders, hence so is `receive`.
  const receive = useCallback((r: RAF) => setResult(() => r), []);
  useBroadcast(store, receive);

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
  const [stale, setStale] = useState(false);

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
              setStale(false);
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
            setStale(isStale);
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
  const [count, setCount] = useState(store.count);
  useBroadcast(
    store,
    useCallback((c: number) => setCount(c), [])
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
  const [count, setCount] = useState(loadingStore.count);
  const [hasResult, setHasResult] = useState(resultStore.hasResult);
  useBroadcast(
    loadingStore,
    useCallback((c: number) => setCount(c), [])
  );
  useBroadcast(
    resultStore,
    useCallback(() => setHasResult(true), [])
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
    if (last instanceof AbortSignal) callContext.signal = last;
    return f(...args);
  }) as F;

/**
 * Runs a function and updates its effects whenever its dependencies change.
 *
 * With `{signal: true}`, each run creates an `AbortController` and passes
 * its signal to the function as an additional trailing argument; the signal
 * is aborted when the dependencies change or the component unmounts. On an
 * injectable, the signal is also exposed as `signal` on the per-call
 * context seen by the injected wrappers.
 *
 * @param {F} fn - The function to run.
 * @param {Parameters<F>} args - The arguments to pass to the function.
 * @param {object} [options] - `signal` (default `false`): append an
 *   `AbortSignal` argument and abort it on cleanup.
 * @example
 * ```tsx
 * const fetchUser = useInjectable(
 *   (id: string, signal: AbortSignal) => fetch(`/users/${id}`, {signal})
 * );
 * useRun(fetchUser, [id], {signal: true});
 * ```
 */
export function useRun<F extends Func>(fn: F, args: Parameters<F>): void;
export function useRun<F extends Func>(
  fn: F,
  args: WithoutSignal<Parameters<F>>,
  options: {signal?: boolean}
): void;
export function useRun<F extends Func>(
  fn: F,
  args: any[],
  options?: {signal?: boolean}
) {
  const {signal = false} = options ?? {};
  try {
    // Register the AbortSignal → callContext bridge. `useRun` also accepts
    // plain (non-`useInjectable`) functions; then there is nothing to inject
    // into and `useInject` throws before consuming any React hooks, so
    // swallowing the error keeps the hook order stable across renders.
    useInject(fn, attachSignal);
  } catch {
    // fn is not injectable — skip injection.
  }
  useEffect(() => {
    if (!signal) {
      void fn(...args);
      return;
    }
    const ac = new AbortController();
    void (fn as Func)(...args, ac.signal);
    return () => ac.abort();
    // Only the destructured `signal` flag (not the whole options object)
    // participates in the dependencies, alongside the call arguments.
  }, [...args, signal]);
}

export {usePolling, useFocusRevalidate} from './polling';

export {useInjectable, createMemoryCacheProvider};
export {stableHash} from '@@/util';
