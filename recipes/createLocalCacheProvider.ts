/**
 * A localStorage-backed cache provider factory — the persistence variant
 * of `createMemoryCacheProvider`.
 *
 * Same "copy me and customize" contract as the hook recipes, applied to
 * the cache side of `useCache`. It COMPOSES the memory provider instead of
 * reimplementing it: the memory map stays the single source of truth for
 * the session, and a storage side-channel mirrors every mutation so the
 * NEXT page load starts warm.
 *
 * When it pays off:
 *
 * - Refresh backfill — F5 hands back the pre-refresh cache instead of a
 *   skeleton flash. Combine with `staleTime`: an entry older than the
 *   window renders instantly from storage, then revalidates in the
 *   background, exactly like any stale hit.
 * - Data written server-side through `hydrate` rides along too — the next
 *   mutation snapshots the whole map, hydrated entries included.
 *
 * Limits to know before adopting:
 *
 * - JSON-safe values only — `JSON.stringify` drops `undefined`/functions,
 *  mangles Dates into strings, and rejects circular structures. Such a
 *  write is skipped silently (see below); the memory cache stays correct
 *  for the session, only the refresh loses that entry.
 * - One snapshot per write — the whole map is re-serialized on every
 *  mutation. Fine at template scale; switch to per-entry storage keys if
 *  your cache grows large.
 * - No cross-tab sync — a `storage` event listener is the natural next
 *  customization point if you need it.
 *
 * Create ONE instance per storage key, at module scope (see
 * `useProjectSWRQuery.ts`): two live instances sharing a key would mirror
 * into the same storage slot and resurrect entries the other one
 * garbage-collected.
 */

import {
  createMemoryCacheProvider,
  type CacheProvider
} from 'react-toolroom/async';

/**
 * Creates a cache provider that behaves exactly like
 * `createMemoryCacheProvider`, plus persists its entries to localStorage
 * under one storage key and refills from it on the next creation.
 *
 * @param {object} [options] - Same options as `createMemoryCacheProvider`,
 *   plus the storage key.
 * @param {string} [options.key='react-toolroom:cache'] - the localStorage
 *   key to persist under — namespace it per cache to avoid collisions.
 * @param {number} [options.cacheTime=Infinity] - idle garbage-collection
 *   window of the memory provider; expiry is persisted too, so collected
 *   entries do not resurrect after a refresh.
 * @param {(k: K) => string} [options.hash=stableHash] - key hash, shared
 *   with the memory provider.
 * @template T - the type of the cached value.
 * @template K - the type of the raw args tuple used as a cache key.
 * @returns {CacheProvider<T, K>} the memory provider when localStorage is
 *   unavailable (SSR, privacy mode), otherwise that same provider with a
 *   storage mirror attached.
 * @example
 * ```tsx
 * // Module scope — one instance per storage key.
 * const projectsCache = createLocalCacheProvider<Project[], any[]>({
 *   key: 'my-app:projects',
 *   cacheTime: 60000
 * });
 *
 * function Projects() {
 *   const loadProjects = useInjectable(fetchProjects);
 *   useCache(loadProjects, projectsCache, 5000);
 *   // ...
 * }
 * ```
 */
export function createLocalCacheProvider<T, K extends any[]>({
  key = 'react-toolroom:cache',
  cacheTime,
  hash
}: {
  key?: string;
  cacheTime?: number;
  hash?: (k: K) => string;
} = {}): CacheProvider<T, K> {
  const memory = createMemoryCacheProvider<T, K>({cacheTime, hash});

  // No window (SSR) or a storage that throws on access (some privacy
  // modes): hand back the plain memory provider, untouched.
  let storage: Storage | undefined;
  try {
    storage = typeof window === 'undefined' ? undefined : window.localStorage;
    const probe = `${key}:probe`;
    storage?.setItem(probe, '1');
    storage?.removeItem(probe);
  } catch {
    storage = undefined;
  }
  if (!storage) return memory;

  // Refill: merge whatever the previous page load persisted. Timestamps
  // survive the JSON round trip, so staleness math stays correct.
  try {
    const raw = storage.getItem(key);
    if (raw) memory.hydrate?.(JSON.parse(raw));
  } catch {
    // Corrupt payload — start empty rather than break the module import.
  }

  // The mirror: one write after every mutation. `subscribe` (part of the
  // memory provider's observation surface) fires after set, delete, clear,
  // deletePrefix AND idle expiry — so the snapshot also records
  // garbage-collected entries instead of resurrecting them on refresh.
  // Writes are best-effort by design: quota exceeded or non-JSON-safe
  // values are swallowed, leaving the memory cache authoritative.
  memory.subscribe?.(() => {
    try {
      storage.setItem(key, JSON.stringify(memory.dehydrate?.() ?? {}));
    } catch {
      // Silent degradation: private mode, quota, or a non-JSON-safe value.
    }
  });

  return memory;
}
