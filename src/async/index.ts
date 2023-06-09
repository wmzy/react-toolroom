/**
 * This module includes the hooks for data-fetching.
 * Hooks can be combined with other hooks.
 *
 * @example
 * ```tsx
 * import {
 *   useResult,
 *   useLoading,
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
 *   const error = useError(fetchUserList);
 *
 *   useRun(fetchUserList, []);
 *
 *   if (loading) return 'loading...';
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
import {useEffect, useRef, useState} from 'react';
import {thru, thruError, thruSet} from '@@/util';
import {useInject, useInjectable, getInjectContext} from './inject';
import {useLoadingFn} from './base';
import createMemoryCacheProvider from './memory-cache-provider';

export {useInject, getInjectContext};

export const setResultKey = Symbol('set result');

/**
 * Get the result of an wrapped async function.
 * @param injectableFn the wrapped async function
 * @param [init] the initial value
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
  const [result, setResult] = useState<RAF | undefined>(init);
  const context = getInjectContext(injectableFn);
  context[setResultKey] = setResult;
  useInject(
    injectableFn,
    (f: AF) => ((...args) => f(...args).then(thruSet(setResult))) as AF
  );
  return result;
}

/**
 * This function is a custom hook that caches the result of an asynchronous function and returns it if it exists
 * in the cache. If not, it calls the function and caches the result for future calls. It also sets a stale time
 * after which the result is considered outdated and will be refetched on the next call. The hook returns a boolean
 * indicating whether the result is stale or not.
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
  const context = getInjectContext(injectableFn);
  const staleRef = useRef(false);

  useEffect(cacheProvider.use, []);

  useInject(
    injectableFn,
    (f: AF) =>
      ((...args) => {
        const setResult = context[setResultKey];
        const refetch = () =>
          f(...args).then((r) => {
            cacheProvider.set(args, r);
            setResult(r);
            staleRef.current = false;
            return r;
          });
        return new Promise<CacheResult<R<AF>>>((resolve) => {
          resolve(cacheProvider.get(args));
        })
          .then((cached: CacheResult<R<AF>>) => {
            if (!cached) return refetch();
            const [data, cachedAt] = cached;
            staleRef.current = Date.now() - cachedAt >= staleTime;
            if (staleRef.current) {
              refetch();
            }
            return data;
          })
          .catch(refetch);
      }) as AF
  );
  return staleRef.current;
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
 * Creates a hook that manages loading state for an injectable async function.
 *
 * @param {AsyncFunc} injectableFn - The async function to inject and track loading state for.
 * @returns {boolean} - The loading state of the injectable function.
 */
export function useLoading<AF extends AsyncFunc>(injectableFn: AF) {
  const [loading, withLoading] = useLoadingFn();
  useInject(injectableFn, withLoading);
  return loading;
}

/**
 * Runs a function and updates its effects whenever its dependencies change.
 *
 * @param {Func} fn - The function to run.
 * @param {Parameters<F>} args - The arguments to pass to the function.
 */
export function useRun<F extends Func>(fn: F, args: Parameters<F>) {
  useEffect(() => void fn(...args), args);
}

export {useInjectable, createMemoryCacheProvider};
