import {AsyncFunc, CacheProvider, CacheResult, Func, R} from '@@/types';
import {useEffect, useRef, useState} from 'react';
import {thru, thruError, thruSet} from '@@/util';
import {useInject, useInjectable, getInjectContext} from './inject';
import {useLoadingFn} from './base';
import createMemoryCacheProvider from './memory-cache-provider';

const setResultKey = Symbol('set result');

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

export function useCatch<E extends Error, AF extends AsyncFunc>(
  injectableFn: AF,
  catcher: (e: E) => R<AF>
) {
  useInject(
    injectableFn,
    (f: AF) => ((...args) => f(...args).catch(thru(catcher))) as AF
  );
}

export function useFinally<AF extends AsyncFunc>(
  injectableFn: AF,
  handler: () => any
) {
  useInject(
    injectableFn,
    (f: AF) => ((...args) => f(...args).finally(handler)) as AF
  );
}

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

export function useLoading<AF extends AsyncFunc>(injectableFn: AF) {
  const [loading, withLoading] = useLoadingFn();
  useInject(injectableFn, withLoading);
  return loading;
}

export function useRun<F extends Func>(fn: F, args: Parameters<F>) {
  useEffect(() => void fn(...args), args);
}

export {useInjectable, createMemoryCacheProvider};
