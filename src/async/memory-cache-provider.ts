import {CacheProvider} from '@@/types';
import {noop} from '@@/util';

/**
 * Returns a cache provider that stores key-value pairs in a map with an optional
 * expiration time.
 *
 * @param {number} cacheTime - The time in milliseconds for the cache to expire.
 * @param {(k: K) => string} hash - The hash function used to generate a unique key
 * for each value.
 * @template T - The type of the value to be stored in the cache.
 * @template K - The type of the key used to retrieve the value from the cache.
 * @returns {CacheProvider<T, K>} Returns an object with methods for getting, setting,
 * deleting, clearing, and managing the cache expiration.
 */
export default function create<T, K extends any[]>({
  cacheTime,
  hash
}: {
  cacheTime: number;
  hash: (k: K) => string;
}): CacheProvider<T, K> {
  const map = new Map<string, [T, number]>();
  let useCount = 0;
  let timer: string | number | NodeJS.Timeout | undefined;
  return {
    get(key: K) {
      const k = hash(key);
      return map.get(k);
    },
    set(key: K, value: T) {
      map.set(hash(key), [value, Date.now()]);
    },
    delete(k: K) {
      map.delete(hash(k));
    },
    clear() {
      map.clear();
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
            timer = undefined;
          }, cacheTime);
        }
      };
    }
  };
}
