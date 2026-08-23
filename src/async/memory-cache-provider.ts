import {CacheProvider} from '@@/types';
import {noop, stableHash} from '@@/util';

/**
 * Returns a cache provider that stores key-value pairs in a map with an optional
 * expiration time.
 *
 * @param {object} [options] - The cache provider options.
 * @param {number} [options.cacheTime=Infinity] - The time in milliseconds for the cache
 * to expire. Defaults to Infinity, meaning the cache never expires on its own.
 * @param {(k: K) => string} [options.hash=stableHash] - The hash function used to generate
 * a unique key for each value. Defaults to {@link stableHash}, which serializes keys
 * deterministically (sorted object keys, structural recursion).
 * @template T - The type of the value to be stored in the cache.
 * @template K - The type of the key used to retrieve the value from the cache.
 * @returns {CacheProvider<T, K>} Returns an object with methods for getting, setting,
 * deleting, clearing, and managing the cache expiration, plus `dehydrate`/`hydrate`
 * for serializing the cache across an SSR boundary, `deletePrefix` for batch
 * invalidation by hashed-key prefix, and `subscribe`/`snapshot` as a read-only
 * observation surface for devtools panels.
 * @example
 * ```tsx
 * const userCache = createMemoryCacheProvider<User, any[]>({cacheTime: 10000});
 * userCache.set([1], alice);
 * userCache.get([1]); // [alice, <timestamp>]
 * ```
 */
export default function create<T, K extends any[]>({
  cacheTime = Infinity,
  hash = stableHash
}: {
  cacheTime?: number;
  hash?: (k: K) => string;
} = {}): CacheProvider<T, K> {
  const map = new Map<string, [T, number]>();
  let useCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Lazy Set — allocated on the first subscribe so caches that are never
  // observed pay nothing. `notify` is a plain closure over it.
  let listeners: Set<() => void>;
  const notify = () => {
    if (listeners) for (const listener of listeners) listener();
  };
  return {
    get(key: K) {
      const k = hash(key);
      return map.get(k);
    },
    set(key: K, value: T) {
      map.set(hash(key), [value, Date.now()]);
      notify();
    },
    delete(k: K) {
      map.delete(hash(k));
      notify();
    },
    clear() {
      map.clear();
      notify();
    },
    use() {
      if (cacheTime === Infinity) return noop;
      useCount++;
      let called = false;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      return () => {
        if (called) return;
        called = true;
        if (--useCount === 0) {
          timer = setTimeout(() => {
            map.clear();
            notify();
            timer = undefined;
          }, cacheTime);
        }
      };
    },
    // SSR transport: `Object.fromEntries` flattens the Map into a plain object
    // whose keys are the hashed strings and whose values are [value, timestamp]
    // tuples — directly `JSON.stringify`-able for embedding in HTML/props.
    dehydrate() {
      return Object.fromEntries(map);
    },
    // Merge semantics on purpose: hydrating must never wipe entries the client
    // has already populated (e.g. from an earlier micro-task), so we write each
    // tuple as-is, preserving the server timestamps that staleness checks use.
    hydrate(data) {
      for (const k in data) {
        map.set(k, data[k]);
      }
    },
    // Deleting while iterating a Map is safe per spec (visited keys removed
    // earlier are skipped, later ones still seen), so no intermediate array.
    deletePrefix(prefix) {
      for (const k of map.keys()) {
        if (k.startsWith(prefix)) {
          map.delete(k);
        }
      }
      notify();
    },
    // Read-only observation surface for devtools: registers a listener that
    // fires after every mutation (set/delete/clear/deletePrefix/expiry).
    subscribe(listener: () => void) {
      if (!listeners) listeners = new Set();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // On-demand shallow copy — never exposes the live Map to consumers.
    snapshot() {
      return [...map].map(([key, [value, cachedAt]]) => ({
        key,
        value,
        cachedAt
      }));
    }
  };
}
