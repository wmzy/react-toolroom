import {AsyncFunc, Func} from '@@/types';
import {stableHash} from '@@/util';
import {useInject} from './inject';

// In-flight registry keyed by the injectable itself: every `useInjectable`
// instance owns a private map, and the whole cache is released once the
// function is garbage-collected — no global provider is needed. Entries are
// short-lived by construction: each one is deleted when its promise settles.
const inflightCache = new WeakMap<Func, Map<string, Promise<any>>>();

/**
 * Deduplicates concurrent calls of an injectable async function: calls with
 * the same hash while one is still in flight share a single promise, so the
 * underlying function executes once and every caller receives the same
 * result. Once the promise settles — successfully or not — the entry is
 * dropped, so subsequent calls run again and a failed call can be retried.
 * This mirrors the request deduplication of react-query.
 *
 * Redundant alongside `createMemoryCacheProvider`: the provider deduplicates
 * in-flight requests itself (`load`) and `useCache` routes every fetch
 * through it, so a cached injectable is already deduped. Kept for custom
 * providers that do not implement `load`, and for injectables that are not
 * cached at all.
 *
 * When several components call `useDedup` on the same injectable, their
 * wrappers share one map: the first wrapper reached by a call stores the
 * promise and any other wrapper in the chain finds it and returns early,
 * which keeps double registration naturally idempotent.
 *
 * The default hash is `stableHash`, which maps every `AbortSignal` to a
 * fixed placeholder — calls differing only in their trailing signal (e.g.
 * reruns of `useRun` with `{signal: true}`) still dedupe.
 *
 * @param {AF} injectableFn - the injectable async function to deduplicate.
 * @param {object} [options] - `hash`: computes the dedup key from the call
 *   arguments. Defaults to `stableHash`.
 * @return {void} Nothing is returned; the hook only registers the wrapper.
 * @example
 * ```tsx
 * import {
 *   useInjectable,
 *   useCache,
 *   useDedup,
 *   useResult,
 *   useRun,
 *   createMemoryCacheProvider
 * } from 'react-toolroom/async';
 *
 * const userCache = createMemoryCacheProvider<User, any[]>({cacheTime: 10000});
 *
 * function User({id}: {id: string}) {
 *   const fetchUser = useInjectable((signal: AbortSignal) => api.user(id, signal));
 *   const isStale = useCache(fetchUser, userCache);
 *   useDedup(fetchUser);
 *   const user = useResult(fetchUser);
 *   useRun(fetchUser, [], {signal: true});
 *
 *   // A stale cache entry triggers a background refetch; useDedup makes
 *   // concurrent refetches share that single in-flight request.
 *   return isStale ? <UserSkeleton user={user} /> : <UserCard user={user} />;
 * }
 * ```
 */
export function useDedup<AF extends AsyncFunc>(
  injectableFn: AF,
  options?: {hash?: (args: Parameters<AF>) => string}
): void {
  useInject(
    injectableFn,
    (f: AF) =>
      ((...args: Parameters<AF>) => {
        let inflight = inflightCache.get(injectableFn);
        if (!inflight) {
          inflight = new Map();
          inflightCache.set(injectableFn, inflight);
        }
        const key = (options?.hash ?? stableHash)(args);
        const existing = inflight.get(key);
        if (existing) return existing;
        const p = f(...args);
        inflight.set(key, p);
        // Delete the entry once it settles so the next call re-runs (and a
        // failed call can be retried). The identity check guards against
        // removing a newer promise that has already replaced this one.
        const settle = () => {
          if (inflight.get(key) === p) inflight.delete(key);
        };
        p.then(settle, settle);
        return p;
      }) as AF
  );
}
