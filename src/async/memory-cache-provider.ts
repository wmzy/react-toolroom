import {CacheEvent, CacheProvider} from '@@/types';
import {noop, stableHash} from '@@/util';

import createMutationBinder from './mutation';

/**
 * One cache entry in any mixture of its two halves: `settled` data and an
 * `inflight` request. An entry can hold either alone (a fresh miss being
 * fetched; data resting between requests) or both at once — stale data
 * served while a background revalidation runs. The raw args tuple stays
 * next to them so deletion events can carry it (subscribers match it
 * structurally, independent of the hash convention) and `deleteWhere`
 * predicates can address it. Hydrated entries have no tuple — only their
 * hashed key survived transport.
 */
type Entry<T, K extends any[]> = {
  args?: K;
  settled?: {value: T; cachedAt: number};
  inflight?: {promise: Promise<T>; gen: number};
};

/**
 * Returns a cache provider that stores key-value pairs in a map with an optional
 * expiration time.
 *
 * Entries are three-state: settled data, an in-flight request, or both.
 * {@link CacheProvider.load} is the read-through primitive — an atomic
 * get-or-insert of the in-flight slot, so every consumer (and every channel:
 * another component's injectable, a router loader) asking for the same args
 * while a request is pending shares that one promise; a per-key generation
 * counter, bumped by every write, keeps a late response from clobbering data
 * that was written while the request was in flight. `peek` reads settled data
 * without observing or starting requests.
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
 * deleting, clearing, and managing the cache expiration, plus `load`/`peek` for
 * in-flight-sharing reads, `dehydrate`/`hydrate` for serializing the cache across
 * an SSR boundary, `deletePrefix`/`deleteWhere` for batch invalidation, and
 * `subscribe`/`snapshot` as a read-only observation surface for devtools panels
 * and `useCache` revalidation.
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
  const map = new Map<string, Entry<T, K>>();
  // Per-key generation counter, bumped by every write that touches a key
  // (set/delete/deletePrefix/deleteWhere; clear wipes the map wholesale).
  // A request captures the generation when it starts; if the generation has
  // moved on by the time it settles, a write landed while it was in flight
  // — the response is older than the cache, and committing it would clobber
  // the newer value. The bump is what turns that commit into a no-op.
  const gens = new Map<string, number>();
  let useCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Lazy Set — allocated on the first subscribe so caches that are never
  // observed pay nothing. `notify` is a plain closure over it.
  let listeners: Set<(e: CacheEvent<K>) => void>;
  const notifySet = () => {
    if (listeners) for (const listener of listeners) listener({type: 'set'});
  };
  const notifyDelete = (entries: Iterable<Entry<T, K>>) => {
    if (!listeners) return;
    // Only entries whose raw tuple is recoverable can be reported; hydrated
    // ones are omitted — no wrapper-driven subscriber has ever seen them.
    const deleted = [...entries]
      .map(({args}) => args)
      .filter((args): args is K => args !== undefined);
    for (const listener of listeners) listener({type: 'delete', deleted});
  };
  const provider: CacheProvider<T, K> = {
    // In-flight requests are invisible to get: it only ever reports settled
    // data, exactly like the pre-load provider did.
    get(key: K) {
      const {settled} = map.get(hash(key)) ?? {};
      return settled && ([settled.value, settled.cachedAt] as [T, number]);
    },
    // Read-only settled lookup — no in-flight observation, no request
    // creation. The routing layer uses it to check a cache synchronously
    // without ever triggering a fetch. The record is copied so callers
    // cannot reach into the entry.
    peek(key: K) {
      const {settled} = map.get(hash(key)) ?? {};
      return settled && {value: settled.value, cachedAt: settled.cachedAt};
    },
    set(key: K, value: T) {
      const h = hash(key);
      const entry = map.get(h);
      if (entry) {
        // Write-through: the data settles immediately. An in-flight request
        // stays registered (its sharers still hold the promise), but the
        // generation bump below makes its late settlement a no-op.
        entry.args = key;
        entry.settled = {value, cachedAt: Date.now()};
      } else {
        map.set(h, {args: key, settled: {value, cachedAt: Date.now()}});
      }
      gens.set(h, (gens.get(h) ?? 0) + 1);
      notifySet();
    },
    // Atomic get-or-insert of the in-flight slot: concurrent loads with the
    // same key share one promise and the factory runs exactly once. The
    // settle write-back lives here, not in the caller — see `finish`.
    load(key: K, factory: () => Promise<T>): Promise<T> {
      const h = hash(key);
      const existing = map.get(h)?.inflight;
      if (existing) return existing.promise;
      const gen = gens.get(h) ?? 0;
      // Materialize the default: an untouched key must read back equal at
      // settlement time (clear() wiping gens then reads as "changed").
      gens.set(h, gen);
      const promise = factory();
      const entry = map.get(h);
      if (entry) {
        // A settled (or hydrated) entry gains its pending half — the stale
        // data stays readable through get while the revalidation runs.
        // Hydrated entries pick up the raw tuple they never had.
        entry.args ??= key;
        entry.inflight = {promise, gen};
      } else {
        map.set(h, {args: key, inflight: {promise, gen}});
      }
      notifySet();
      const finish = (value?: {v: T}) => {
        const cur = map.get(h);
        // Identity guard first: delete/clear/expiry or a newer load already
        // dropped or replaced this registration — a late settlement must
        // not resurrect the entry or touch its successor.
        if (cur?.inflight?.promise !== promise) return;
        cur.inflight = undefined;
        if (value && gens.get(h) === gen) {
          // cachedAt counts from settlement, not from when the request
          // started, so a slow response does not eat into the data's
          // cacheTime/staleTime budget.
          cur.settled = {value: value.v, cachedAt: Date.now()};
        }
        // A record holding neither data nor a pending request is not an
        // entry — drop it so snapshots and get stay honest.
        if (!cur.settled) map.delete(h);
        notifySet();
      };
      // A rejection is an ordinary settle for the bookkeeping — the
      // in-flight slot is vacated (a retry can start fresh), any settled
      // data is kept (SWR: a failed background refetch leaves the stale
      // value on screen) — and then rethrown to the caller as-is.
      promise.then(
        (v) => finish({v}),
        () => finish()
      );
      return promise;
    },
    delete(k: K) {
      const h = hash(k);
      const entry = map.get(h);
      map.delete(h);
      if (entry) {
        gens.set(h, (gens.get(h) ?? 0) + 1);
        notifyDelete([entry]);
      }
    },
    clear() {
      // Remove first, notify after: a listener's revalidation reads the
      // cache synchronously, so it must observe the entries already gone
      // (hard miss → refetch), not re-hit what it is being told was purged.
      const deleted = [...map.values()];
      map.clear();
      gens.clear();
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
            gens.clear();
            notifyDelete(deleted);
            timer = undefined;
          }, cacheTime);
        }
      };
    },
    // SSR transport: `Object.fromEntries` flattens the Map into a plain object
    // whose keys are the hashed strings and whose values are [value, timestamp]
    // tuples — directly `JSON.stringify`-able for embedding in HTML/props.
    // In-flight-only entries have nothing to transport and are skipped.
    dehydrate() {
      return Object.fromEntries(
        [...map]
          .filter(([, entry]) => entry.settled !== undefined)
          .map(([k, {settled}]) => [k, [settled!.value, settled!.cachedAt]])
      );
    },
    // Merge semantics on purpose: hydrating must never wipe entries the client
    // has already populated (e.g. from an earlier micro-task), so we write each
    // settled half as-is, preserving the server timestamps that staleness
    // checks use. A pending request on the same key keeps running.
    hydrate(data: Record<string, [T, number]>) {
      for (const k in data) {
        const [value, cachedAt] = data[k];
        const entry = map.get(k);
        if (entry) entry.settled = {value, cachedAt};
        else map.set(k, {args: undefined, settled: {value, cachedAt}});
      }
    },
    // Deleting while iterating a Map is safe per spec (visited keys removed
    // earlier are skipped, later ones still seen), so no intermediate array.
    deletePrefix(prefix: string) {
      const deleted: Entry<T, K>[] = [];
      for (const [k, entry] of map) {
        if (k.startsWith(prefix)) {
          deleted.push(entry);
          map.delete(k);
          gens.set(k, (gens.get(k) ?? 0) + 1);
        }
      }
      notifyDelete(deleted);
    },
    deleteWhere(predicate: (k: K) => boolean) {
      const deleted: Entry<T, K>[] = [];
      for (const [k, entry] of map) {
        if (entry.args !== undefined && predicate(entry.args)) {
          deleted.push(entry);
          map.delete(k);
          gens.set(k, (gens.get(k) ?? 0) + 1);
        }
      }
      notifyDelete(deleted);
    },
    // Batch write-side twin of deleteWhere: same addressing (raw args
    // predicate, hydrated entries skipped), but the entry survives with the
    // updater's value. In-place entry mutation + generation bump keep the
    // write identical to set()'s; one batched 'set' event fires when
    // anything changed, so subscribers read a consistent post-state.
    patchWhere(
      predicate: (k: K) => boolean,
      updater: (value: T, k: K) => T | void
    ) {
      const patched: {args: K; prev: T; next: T}[] = [];
      for (const [h, entry] of map) {
        const {args, settled} = entry;
        if (args === undefined || settled === undefined) continue;
        if (!predicate(args)) continue;
        const next = updater(settled.value, args);
        if (next === undefined) continue;
        const prev = settled.value;
        entry.settled = {value: next, cachedAt: Date.now()};
        gens.set(h, (gens.get(h) ?? 0) + 1);
        patched.push({args, prev, next});
      }
      if (patched.length) notifySet();
      return patched;
    },
    // Read-only observation surface for devtools: registers a listener that
    // fires after every mutation (set/delete/clear/deleteWhere/deletePrefix/
    // load register & settle/expiry) with what changed.
    subscribe(listener: (e: CacheEvent<K>) => void) {
      (listeners ??= new Set()).add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // On-demand shallow copy — never exposes the live Map to consumers.
    // In-flight-only entries are omitted (no data to show); entries that
    // carry data while a request runs get an additive `pending` marker.
    snapshot() {
      return [...map].flatMap(([key, entry]) => {
        const {settled} = entry;
        if (!settled) return [];
        const row: {
          key: string;
          value: T;
          cachedAt: number;
          pending?: boolean;
        } = {key, value: settled.value, cachedAt: settled.cachedAt};
        if (entry.inflight) row.pending = true;
        return [row];
      });
    }
  };
  // cache.mutation lives as a lazy method so the object above stays a plain
  // data surface; the binder only needs peek/set/patchWhere, all closed
  // over already. Assigned after the literal — self-reference at call time.
  provider.mutation = createMutationBinder(provider).mutation;
  return provider;
}
