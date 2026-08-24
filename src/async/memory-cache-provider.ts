import {CacheEvent, CacheProvider} from '@@/types';
import {noop, stableHash} from '@@/util';

/**
 * Returns a cache provider that stores key-value pairs in a map with an optional
 * expiration time.
 *
 * @param {object} [options] - The cache provider options.
 * @param {number} [options.cacheTime=Infinity] - The time in milliseconds for the cache to
 * expire. Defaults to Infinity, meaning the cache never expires on its own.
 * @param {(k: K) => string} [options.hash=stableHash] - The hash function used to generate
 * a unique key for each value. Defaults to {@link stableHash}, which serializes keys
 * deterministically (sorted object keys, structural recursion).
 * @template T - The type of the value to be stored in the cache.
 * @template K - The type of the key used to retrieve the value from the cache.
 * @returns {CacheProvider<T, K>} Returns an object with methods for getting, setting,
 * deleting, clearing, and managing the cache expiration, plus `dehydrate`/`hydrate`
 * for serializing the cache across an SSR boundary, `deletePrefix`/`deleteWhere` for
 * batch invalidation, and `subscribe`/`snapshot` as a read-only observation surface
 * for devtools panels and `useCache` revalidation.
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
  // Internal entries keep the RAW args tuple next to the value: deletion
  // events carry it (subscribers match it structurally, independent of the
  // hash convention) and `deleteWhere` predicates address it. Hydrated
  // entries have no tuple — only their hashed key survived transport.
  const map = new Map<string, [K | undefined, T, number]>();
  let useCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Lazy Set — allocated on the first subscribe so caches that are never
  // observed pay nothing. `notify` is a plain closure over it.
  let listeners: Set<(e: CacheEvent<K>) => void>;
  const notifySet = () => {
    if (listeners) for (const listener of listeners) listener({type: 'set'});
  };
  const notifyDelete = (entries: Iterable<[K | undefined, T, number]>) => {
    if (!listeners) return;
    // Only entries whose raw tuple is recoverable can be reported; hydrated
    // ones are omitted — no wrapper-driven subscriber has ever seen them.
    const deleted = [...entries]
      .map(([args]) => args)
      .filter((args): args is K => args !== undefined);
    for (const listener of listeners) listener({type: 'delete', deleted});
  };
  return {
    get(key: K) {
      const entry = map.get(hash(key));
      return entry && ([entry[1], entry[2]] as [T, number]);
    },
    set(key: K, value: T) {
      map.set(hash(key), [key, value, Date.now()]);
      notifySet();
    },
    delete(k: K) {
      const key = hash(k);
      const entry = map.get(key);
      map.delete(key);
      if (entry) notifyDelete([entry]);
    },
    clear() {
      // Remove first, notify after: a listener's revalidation reads the
      // cache synchronously, so it must observe the entries already gone
      // (hard miss → refetch), not re-hit what it is being told was purged.
      const deleted = [...map.values()];
      map.clear();
      notifyDelete(deleted);
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
            // Delete before notify — same invariant as clear().
            const deleted = [...map.values()];
            map.clear();
            notifyDelete(deleted);
            timer = undefined;
          }, cacheTime);
        }
      };
    },
    // SSR transport: `Object.fromEntries` flattens the Map into a plain object
    // whose keys are the hashed strings and whose values are [value, timestamp]
    // tuples — directly `JSON.stringify`-able for embedding in HTML/props.
    dehydrate() {
      return Object.fromEntries(
        [...map].map(([k, [, value, cachedAt]]) => [k, [value, cachedAt]])
      );
    },
    // Merge semantics on purpose: hydrating must never wipe entries the client
    // has already populated (e.g. from an earlier micro-task), so we write each
    // tuple as-is, preserving the server timestamps that staleness checks use.
    hydrate(data: Record<string, [T, number]>) {
      for (const k in data) {
        map.set(k, [undefined, data[k][0], data[k][1]]);
      }
    },
    // Deleting while iterating a Map is safe per spec (visited keys removed
    // earlier are skipped, later ones still seen), so no intermediate array.
    deletePrefix(prefix: string) {
      const deleted: [K | undefined, T, number][] = [];
      for (const [k, entry] of map) {
        if (k.startsWith(prefix)) {
          deleted.push(entry);
          map.delete(k);
        }
      }
      notifyDelete(deleted);
    },
    deleteWhere(predicate: (k: K) => boolean) {
      const deleted: [K | undefined, T, number][] = [];
      for (const [k, entry] of map) {
        if (entry[0] !== undefined && predicate(entry[0])) {
          deleted.push(entry);
          map.delete(k);
        }
      }
      notifyDelete(deleted);
    },
    // Read-only observation surface for devtools: registers a listener that
    // fires after every mutation (set/delete/clear/deleteWhere/deletePrefix/
    // expiry) with what changed.
    subscribe(listener: (e: CacheEvent<K>) => void) {
      (listeners ??= new Set()).add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // On-demand shallow copy — never exposes the live Map to consumers.
    snapshot() {
      return [...map].map(([key, [, value, cachedAt]]) => ({
        key,
        value,
        cachedAt
      }));
    }
  };
}
