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
 *   re-hydrated. The listener's lifetime follows the provider's
 *   reachability: a module singleton keeps it — and its convergence — for
 *   the page's whole life, while a provider nothing references anymore
 *   stops rooting itself on `window`: the handler derefs a WeakRef per
 *   event and a FinalizationRegistry detaches it once the provider is
 *   collected. The memory provider's own sweep timers may delay that
 *   collection by up to `cacheTime` — bounded, and GC-correct.
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

  // Cross-tab convergence and the event-aware clear wipe, installed by the
  // two module-private helpers below — separate functions on purpose, not
  // for tidiness: their closures share the `syncing` flag, so they must
  // share a scope with the storage handler, and that scope must NOT also
  // capture `provider`. Closures capture whole scopes, not single variables
  // (one context per scope, shared by every closure over it): a `provider`
  // binding in the handler's scope would give `window` → handler → scope →
  // provider — a strong edge no WeakRef can break. See the helper headers.
  //
  // The contract the helpers implement: while the provider is reachable —
  // a module singleton, for the page's whole life, unchanged — the
  // listener stays attached and a storage event for this key (another
  // tab's new mirror, `newValue` set, or its logout wipe, `null`) drops
  // this tab's memory so consumers refetch server truth; foreign bytes
  // are never re-hydrated, and a cache that stops mirroring (suspended)
  // keeps converging. Once the provider is unreachable, `window` must not
  // root the inert closure forever: the handler derefs a WeakRef per
  // matching event and a FinalizationRegistry detaches the handler after
  // collection, without waiting for a storage event. (The memory
  // provider's own sweep timers may keep it reachable for up to
  // `cacheTime` after its last write — bounded, and GC-correct: a pending
  // timer is a live reference like any other.)
  const isSyncing = attachCrossTabListener(provider, key);
  wrapClearForCrossTab(provider, isSyncing, key, storage);
}

/**
 * The cross-tab storage listener: while the provider is reachable, a
 * matching storage event (another tab's new mirror or its logout wipe)
 * clears this tab's memory so consumers refetch server truth. Returns the
 * `syncing` flag's reader for the clear wrapper — a storage-event-triggered
 * clear must skip its removeItem, or the wipe would restart the very chain
 * the event is converging.
 *
 * The listener's lifetime follows the provider's REACHABILITY, and the
 * scope discipline in here is what makes that real. The handler must stay
 * window-rooted, so everything its closure captures (`key`, the WeakRef,
 * the registry, its token, `syncing`) must not reach the provider
 * strongly: `provider` is used only synchronously below — WeakRef
 * construction, registry registration — and captured by no closure, so it
 * dies with this call's frame. A `provider` binding captured by any
 * closure of this function would hand `window` a strong edge
 * (`window` → handler → context → provider) that no WeakRef can break.
 *
 * The FinalizationRegistry detaches the handler once the provider is
 * collected, without waiting for a storage event to notice. But a registry
 * nothing references dies with its target and never fires — it must stay
 * reachable while the handler lives: the handler's dead path references it
 * (`window` → handler → registry), and once the finalizer removes the
 * handler that whole cycle is unreachable too.
 */
function attachCrossTabListener<T, K extends any[]>(
  provider: CacheProvider<T, K>,
  key: string
): () => boolean {
  const providerRef = new WeakRef(provider);
  const token = {};
  const registry = new FinalizationRegistry<void>(() => {
    window.removeEventListener('storage', onStorage);
  });
  registry.register(provider, undefined, token);
  let syncing = false;
  // A function DECLARATION, not a const arrow: the registry callback
  // above references `onStorage` before this line — runtime-safe (the
  // finalizer only fires post-collection, long after this frame) and the
  // lint rule's `functions: false` option reads declarations as hoisted
  // (the same pattern memory-cache-provider's `scheduleSweep` uses).
  function onStorage(ev: StorageEvent) {
    if (ev.key !== key) return;
    const live = providerRef.deref();
    if (live === undefined) {
      // Dead path — the provider is gone; nothing left to converge.
      // Unregister before detaching: a no-op once the finalizer already
      // ran, but this reference is also what keeps the registry (and with
      // it the finalizer) alive while the handler is still attached.
      registry.unregister(token);
      window.removeEventListener('storage', onStorage);
      return;
    }
    syncing = true;
    try {
      live.clear();
    } finally {
      syncing = false;
    }
  }
  window.addEventListener('storage', onStorage);
  return () => syncing;
}

/**
 * The clear() wipe: delete events have already mirrored the empty table;
 * the explicit removeItem guarantees the outcome even when that write was
 * swallowed (quota) — the logout guarantee, for free on every clear.
 * Storage-event-triggered clears skip it (the `isSyncing` reader): the
 * event-driven empty write is what converges the two tabs, and a
 * removeItem would restart the chain.
 *
 * Same scope discipline as the listener, from the other side: the wrapper
 * becomes a property of the provider, so its closure lives and dies with
 * the provider's own cluster — it captures the original `clear`, the
 * reader, `key` and `storage`, never the provider binding itself, and
 * nothing here is window-rooted. The captured original `clear` keeps the
 * provider's factory scope alive, but only through the provider — the
 * cluster is collectable the moment the provider is.
 */
function wrapClearForCrossTab<T, K extends any[]>(
  provider: CacheProvider<T, K>,
  isSyncing: () => boolean,
  key: string,
  storage: Storage
): void {
  const {clear} = provider;
  provider.clear = () => {
    clear();
    if (isSyncing()) return;
    try {
      storage.removeItem(key);
    } catch {
      // Silent — same degradation contract as the mirror.
    }
  };
}
