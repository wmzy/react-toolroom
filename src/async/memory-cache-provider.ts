import {CacheEvent, CacheProvider} from '@@/types';
import {isAbortSignal, noop, stableHash} from '@@/util';

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
  /** Last activity timestamp — the per-entry GC clock (see {@link touch}). */
  lastUsedAt: number;
  /** True while a mounted `useCache` observer has consumed this entry — exempt from GC. */
  observed?: boolean;
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
 * Reclamation is per entry, not per table. Every entry carries a
 * `lastUsedAt` clock refreshed by every access (`get`/`peek`) and every
 * write or settle (`set`/`load` register & settle/`patchWhere`/`hydrate`).
 * When a finite `cacheTime` is set, two channels sweep: the last unmounted
 * `use()` consumer schedules one final scan, and every write debounce-schedules
 * a scan so entries nobody consumes (a router loader priming the cache)
 * are reclaimed too. An entry is deleted when it has been idle — no access,
 * no write — for the full `cacheTime` and carries no in-flight request;
 * an entry observed by a mounted `useCache` consumer (marked via `observe`)
 * is exempt until unobserved. The sweep emits the same
 * `{type: 'delete', deleted: [...]}` events as `delete`.
 * `cacheTime: Infinity` never reclaims.
 *
 * @param {object} [options] - The cache provider options.
 * @param {number} [options.cacheTime=Infinity] - The time in milliseconds an idle
 * entry is kept before being reclaimed (per-entry, like TanStack Query's
 * `gcTime`). Every access or write refreshes the entry's clock; `Infinity`
 * (the default) means entries are never reclaimed on their own.
 * @param {(k: K) => string} [options.hash=stableHash] - The hash function used to generate
 * a unique key for each value. Defaults to {@link stableHash}, which serializes keys
 * deterministically (sorted object keys, structural recursion).
 * @template T - The type of the value to be stored in the cache.
 * @template K - The type of the key used to retrieve the value from the cache.
 * @returns {CacheProvider<T, K>} Returns an object with methods for getting, setting,
 * deleting, clearing, and managing the cache expiration, plus `load`/`peek` for
 * in-flight-sharing reads, `dehydrate`/`hydrate` for serializing the cache across
 * an SSR boundary, `deletePrefix`/`deleteWhere` for batch invalidation,
 * `deleteKey` for structural single-entry removal by the hashed key a
 * snapshot row carries, and
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
  // The per-entry GC clock. Every access or write refreshes it, so an
  // entry stays alive as long as anything keeps touching it — the direct
  // analogue of TanStack Query refreshing `gcTime` on each observation.
  const touch = (entry: Entry<T, K>) => {
    entry.lastUsedAt = Date.now();
    // A read proves somebody still cares about this entry: let the sweep
    // channel know the deadline moved. (get/peek route through here too,
    // so polling readers keep their entries alive indefinitely.)
    scheduleSweep();
  };
  // An entry is reclaimable when it sat idle for the full `cacheTime`,
  // carries no pending request (an inflight request is live work — never
  // collect it) and has no observed consumer (a mounted `useCache`
  // observer keeps its entry alive exactly like TanStack Query's gcTime
  // keeps a query with observers). `cacheTime === Infinity` never reaches
  // the sweep.
  const expired = (entry: Entry<T, K>) =>
    entry.inflight === undefined &&
    entry.observed !== true &&
    Date.now() - entry.lastUsedAt >= cacheTime;
  // Per-entry sweep: delete every idle entry, then notify once — batched
  // so listeners revalidate against the fully swept state, not a mix.
  const sweep = () => {
    if (cacheTime === Infinity) return;
    const deleted: Entry<T, K>[] = [];
    for (const [h, entry] of map) {
      if (expired(entry)) {
        deleted.push(entry);
        map.delete(h);
      }
    }
    if (deleted.length) notifyDelete(deleted);
  };
  // Channel ② — the write-driven debounce sweep. `use()` only observes
  // component consumers; entries written through channels nobody mounts
  // (a router loader priming the cache) would otherwise sit forever. Every
  // write schedules one scan at `cacheTime` from now; a later write
  // postpones it. The channel-① timer, while consumers are mounted, keeps
  // entries young enough that the scans find nothing — the channels are
  // independent and idempotent. With `reset = false` an already pending
  // scan is left alone (its earlier deadline sweeps later writes too);
  // `use()`'s re-arm passes it so it never extends its own deadline.
  // A function DECLARATION (not a const arrow): `touch` above calls it
  // before this line, which is safe — declarations hoist and `touch` only
  // runs post-initialization — while keeping the lint rule satisfied.
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleSweep(reset = true) {
    if (cacheTime === Infinity) return;
    if (sweepTimer !== undefined) {
      if (!reset) return;
      clearTimeout(sweepTimer);
    }
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined;
      sweep();
    }, cacheTime);
  }
  // Observer bookkeeping — the `use` observer API marks the tuples its
  // mounted consumer has fetched (and unmarks on unmount). Observed KEYS
  // (not just entries) are tracked so a key re-created later by `set`/
  // `load` inherits the exemption — an observer watches the data identity,
  // not one entry object. The set holds per-key observer COUNTS: several
  // consumers may share one key, and the exemption must outlive each of
  // them until the last one unmounts (TanStack counts observers the same
  // way). Observing cancels any pending write-driven scan: while an
  // observer is mounted its entries are exempt from GC anyway, and
  // per-entry exemption means the single global sweep deadline can never
  // resurrect the refetch loop. Unobserving re-arms the sweep (channel ②)
  // once the count reaches zero, so the released entries are reclaimed
  // after their idle window even with no further writes.
  const observedRefs = new Map<string, number>();
  const applyObserved = (h: string, on: boolean) => {
    if (on) {
      observedRefs.set(h, (observedRefs.get(h) ?? 0) + 1);
    } else {
      const n = (observedRefs.get(h) ?? 0) - 1;
      if (n <= 0) observedRefs.delete(h);
      else observedRefs.set(h, n);
    }
    const entry = map.get(h);
    if (entry) entry.observed = observedRefs.has(h);
  };
  const observeArgs = (args: K[], on: boolean) => {
    // An empty batch observes nothing — it must not cancel a pending scan
    // either, or a mounted-but-never-called consumer would strand unrelated
    // loader-written entries for as long as it stays mounted.
    if (args.length === 0) return;
    for (const tuple of args) applyObserved(hash(tuple), on);
    if (on && sweepTimer !== undefined) {
      clearTimeout(sweepTimer);
      sweepTimer = undefined;
    }
    if (!on) scheduleSweep();
  };
  const provider: CacheProvider<T, K> = {
    // In-flight requests are invisible to get: it only ever reports settled
    // data, exactly like the pre-load provider did.
    get(key: K) {
      const entry = map.get(hash(key));
      if (!entry?.settled) return undefined;
      touch(entry);
      return [entry.settled.value, entry.settled.cachedAt] as [T, number];
    },
    // Read-only settled lookup — no in-flight observation, no request
    // creation. The routing layer uses it to check a cache synchronously
    // without ever triggering a fetch. The record is copied so callers
    // cannot reach into the entry.
    peek(key: K) {
      const entry = map.get(hash(key));
      if (!entry?.settled) return undefined;
      touch(entry);
      const {value, cachedAt} = entry.settled;
      return {value, cachedAt};
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
        touch(entry);
      } else {
        map.set(h, {
          args: key,
          settled: {value, cachedAt: Date.now()},
          lastUsedAt: Date.now(),
          observed: observedRefs.has(h)
        });
      }
      gens.set(h, (gens.get(h) ?? 0) + 1);
      scheduleSweep();
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
        touch(entry);
      } else {
        map.set(h, {
          args: key,
          inflight: {promise, gen},
          lastUsedAt: Date.now(),
          observed: observedRefs.has(h)
        });
      }
      scheduleSweep();
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
        touch(cur);
        // A record holding neither data nor a pending request is not an
        // entry — drop it so snapshots and get stay honest.
        if (!cur.settled) map.delete(h);
        notifySet();
      };
      // Abort-yield, wired into the creation path so every load caller (a
      // `useCache` wrapper, a router loader, a raw provider consumer) gets
      // it for free: when the args tuple ends in an AbortSignal — the
      // established convention for "this call is cancellable" (`useRun`'s
      // `{signal: true}` appends it; `stableHash` collapses every signal
      // to one placeholder) — the freshly created slot dies with that
      // signal. A signal's `abort` event fires SYNCHRONOUSLY, ahead of the
      // microtask that would vacate the slot through the settle `then`
      // below; in that window a new load for the same key would join the
      // dead promise and inherit its AbortError forever (the replacement
      // consumer mounting in the same synchronous stack as the old one's
      // unmount). The creation path is the exact creator/joiner
      // discriminator: a joiner returned `existing.promise` above before
      // ever reaching here, so its own signal — which cannot cancel the
      // underlying request — never vacates the shared slot. The drop is
      // `finish()` with no value: same identity guard (an aborted request
      // can never knock a successor's registration out of the table), same
      // husk rule, and the one honest `set` event for snapshot readers —
      // but never a `delete` event, which would make mounted consumers
      // re-run the args (a double fetch). Holders of the dropped promise
      // are unaffected: the physical rejection still reaches them, which
      // is semantically correct — they subscribed to a request that was in
      // fact cancelled. Only FUTURE loads are pointed at a fresh request,
      // and the dropped promise's own settle microtask later fails the
      // identity guard and returns without touching anything.
      const last = key[key.length - 1];
      if (isAbortSignal(last)) {
        // A listener on an already-aborted signal never fires — that call
        // is its own replacement (e.g. an effect re-ran after its cleanup
        // aborted), so the dead-on-arrival slot is vacated immediately.
        if (last.aborted) finish();
        else last.addEventListener('abort', () => finish(), {once: true});
      }
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
    // Structural-addressing twin of delete: the caller already holds the
    // hashed key — a snapshot row's `key`, recorded at write time — so the
    // removal cannot miss the way a re-hashed raw tuple can (an in-place
    // args mutation after `set`, or a hydrated entry that never had one).
    // Same bookkeeping as delete: generation bump (an in-flight request
    // captured under the old generation must not resurrect the entry),
    // deletion event carrying the raw tuple when recoverable. A miss is a
    // silent no-op — listeners only hear real removals.
    deleteKey(h: string) {
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
    // Marks/unmarks args tuples as observed by a mounted `useCache`
    // consumer. Observed entries are exempt from per-entry GC — exactly
    // TanStack Query's "a query with observers is never collected".
    // Optional extension; custom providers may omit it.
    observe(args: K[], on: boolean) {
      observeArgs(args, on);
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
            timer = undefined;
            // Per-entry reclamation instead of a wholesale clear: sweep
            // entries idle for the full `cacheTime` (an in-flight request
            // keeps its entry alive). Before going idle, re-arm once —
            // without resetting an earlier deadline — so a write that lands
            // during this final window still gets channel ② coverage.
            scheduleSweep(false);
            // Delete before notify — same invariant as clear().
            sweep();
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
        if (entry) {
          entry.settled = {value, cachedAt};
          touch(entry);
        } else {
          map.set(k, {
            args: undefined,
            settled: {value, cachedAt},
            lastUsedAt: Date.now()
          });
        }
      }
      scheduleSweep();
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
        touch(entry);
        gens.set(h, (gens.get(h) ?? 0) + 1);
        patched.push({args, prev, next});
      }
      if (patched.length) {
        scheduleSweep();
        notifySet();
      }
      return patched;
    },
    // Read-only observation surface for devtools: registers a listener that
    // fires after every mutation (set/delete/clear/deleteWhere/deletePrefix/
    // load register & settle/per-entry GC) with what changed.
    subscribe(listener: (e: CacheEvent<K>) => void) {
      (listeners ??= new Set()).add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // On-demand shallow copy — never exposes the live Map to consumers.
    // In-flight-only entries are omitted (no data to show); entries that
    // carry data while a request runs get an additive `pending` marker.
    // Deletion events from the per-entry GC read like `delete`'s.
    snapshot() {
      return [...map].flatMap(([key, entry]) => {
        const {settled} = entry;
        if (!settled) return [];
        const row: {
          key: string;
          value: T;
          cachedAt: number;
          pending?: boolean;
          args?: K;
        } = {key, value: settled.value, cachedAt: settled.cachedAt};
        if (entry.inflight) row.pending = true;
        // Additive raw tuple, when recoverable: hydrated entries (SSR)
        // carry no args and stay `undefined` — devtools Remove buttons
        // feature-detect on it instead of synthesizing a tuple from the
        // hashed key.
        if (entry.args !== undefined) row.args = entry.args;
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
