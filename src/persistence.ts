import type {CacheProvider, PersistOptions} from '@@/types';

/**
 * localStorage persistence for `createMemoryCacheProvider`: one storage key
 * mirrors every settled entry, and the next creation refills from it.
 *
 * Attached inside the factory, but composed strictly through the provider's
 * own public seams (`hydrate`/`dehydrate`/`subscribe`/`clear`) — the same
 * composition a custom persistence layer could build on any provider:
 *
 * - Creation-time hydrate, synchronous. The payload is `{v, data}` where
 *   `data` maps hashed keys to `[value, cachedAt]` pairs; both the version
 *   and a coarse shape check must pass. Anything invalid — corrupt JSON, a
 *   bare pre-version table, a future `v` — is discarded wholesale and
 *   silently: the disk holds a rebuildable mirror, not a source of truth,
 *   so there is no migration and no wipe (a rejected read must not erase
 *   what it rejected; the next real write overwrites it). `cachedAt`
 *   survives the round trip, so a restarted entry keeps its real age for
 *   staleness math — it serves immediately and revalidates in the
 *   background (SWR), never masquerading as fresh.
 * - Every cache event (set/delete/clear/GC — one paramless callback) mirrors
 *   the full table. The pre-write diff compares against the CURRENT stored
 *   value (never a cached last write): after a cross-tab storage event
 *   clears this tab, the delete event writes the now-empty table back, and
 *   only the diff keeps that ping-pong at one round.
 * - Cross-tab: a storage event for this key — another tab's new mirror
 *   (`newValue` set) or its logout wipe (`newValue: null`) — clears this
 *   tab's memory so consumers refetch server truth. Foreign bytes are never
 *   re-hydrated.
 * - `clear()` writes the empty table first (through the mirror above), then
 *   removes the key outright — belt-and-braces, so a quota-swallowed empty
 *   write cannot leave the previous session's mirror behind. Clears
 *   triggered by a storage event skip the removal: the event-driven empty
 *   write is what converges the two tabs.
 * - Every storage exception is silent: SSR (no window), a throwing
 *   localStorage (some privacy modes), quota exceeded, or a non-JSON-safe
 *   value degrade to a plain memory cache or a skipped write — the memory
 *   cache stays authoritative.
 *
 * @param provider - The memory cache provider to attach persistence to.
 * @param options - The {@link PersistOptions}; `key` is required.
 */
export default function attachPersistence<T, K extends any[]>(
  provider: CacheProvider<T, K>,
  {key, version = 1, enabled = () => true}: PersistOptions
): void {
  // Probe: no window (SSR) or a throwing localStorage (some privacy modes)
  // → no persistence at all, the provider stays a plain memory cache.
  let probed: Storage | undefined;
  try {
    probed = typeof window === 'undefined' ? undefined : window.localStorage;
    probed?.setItem(`${key}:probe`, '1');
    probed?.removeItem(`${key}:probe`);
  } catch {
    probed = undefined;
  }
  if (!probed) return;
  const storage = probed;

  // Coarse shape check of the `data` table: entry values are
  // `[value, cachedAt]` pairs. Not a deep validation — the write side
  // guarantees the value type; what this catches is hand-edited, truncated,
  // or old-schema structural damage, and the answer to that is discarding
  // the whole table, not salvaging entries one by one.
  const isTable = (v: unknown): v is Record<string, [unknown, number]> =>
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.values(v).every(
      (e) => Array.isArray(e) && e.length === 2 && typeof e[1] === 'number'
    );

  // Creation-time hydrate. `hydrate` MERGES and keeps the stored `cachedAt`,
  // so a restarted entry stays as old as it really is — stale entries serve
  // immediately and revalidate in the background.
  try {
    if (enabled()) {
      const raw = storage.getItem(key);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'v' in parsed &&
          (parsed as {v: unknown}).v === version &&
          'data' in parsed &&
          isTable((parsed as {data: unknown}).data)
        ) {
          provider.hydrate?.(
            (parsed as {data: Record<string, [T, number]>}).data
          );
        }
      }
    }
  } catch {
    // Corrupt payload — start empty rather than break the module import.
  }

  // The mirror: one write after every cache event. `enabled` is checked
  // inside the try so a throwing predicate degrades like any other storage
  // failure instead of breaking the cache mutation that triggered it.
  provider.subscribe?.(() => {
    try {
      if (!enabled()) return;
      const next = JSON.stringify({
        v: version,
        data: provider.dehydrate?.() ?? {}
      });
      if (next !== storage.getItem(key)) storage.setItem(key, next);
    } catch {
      // Quota exceeded or a non-JSON-safe value: silent degradation, the
      // memory cache stays authoritative.
    }
  });

  // Cross-tab convergence. Storage events fire in OTHER documents only;
  // both a new mirror (`newValue` set) and a logout wipe (`null`) get the
  // same answer: drop this tab's memory, consumers refetch server truth.
  // The listener stays attached for the provider's whole life — a cache
  // that stops mirroring (suspended) must keep converging.
  let syncing = false;
  const onStorage = (ev: StorageEvent) => {
    if (ev.key !== key) return;
    syncing = true;
    try {
      provider.clear();
    } finally {
      syncing = false;
    }
  };
  window.addEventListener('storage', onStorage);

  // The clear() wipe: delete events have already mirrored the empty table;
  // the explicit removeItem guarantees the outcome even when that write was
  // swallowed (quota) — the logout guarantee, for free on every clear.
  // Storage-event-triggered clears skip it: the event-driven empty write is
  // what converges the two tabs, and a removeItem would restart the chain.
  const {clear} = provider;
  provider.clear = () => {
    clear();
    if (syncing) return;
    try {
      storage.removeItem(key);
    } catch {
      // Silent — same degradation contract as the mirror.
    }
  };
}
