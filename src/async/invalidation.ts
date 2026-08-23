import {AsyncFunc, CacheProvider, Func} from '@@/types';
import {useEffect} from 'react';
import {noop, stableHash} from '@@/util';
import {emitStale, getStaleStore} from './base';
import {getInjectContext} from './inject';

/**
 * One declarative invalidation target:
 *
 * - the injectable alone — every cache entry bound to it (`useCache` binds
 *   providers to the injectable as long as it lives);
 * - an `[injectable, ...argsPrefix]` tuple — only the entries whose call
 *   arguments structurally extend the prefix, so `[fetchFeed, 'news']`
 *   leaves the `sports` tab alone and `[fetchUser, id]` invalidates that
 *   one user regardless of the trailing arguments.
 *
 * The prefix elements are checked element-wise against the injectable's
 * parameters (see {@link ValidatedTargets}); at runtime, matching compares
 * `stableHash` per position — the same equivalence the cache keys use.
 */
export type InvalidateTarget<AF extends AsyncFunc = AsyncFunc> =
  | AF
  | readonly [injectable: AF, ...argsPrefix: Partial<Parameters<AF>>];

/**
 * Validates one element of an `invalidates` array: an injectable alone, or
 * an `[injectable, ...prefix]` tuple whose prefix is assignable to the
 * leading parameters of the injectable in the head. An invalid element
 * collapses to `never`, so the containing array rejects the literal and
 * the error points at the offending slot.
 */
type ValidTarget<T> = T extends readonly [
  infer F extends AsyncFunc,
  ...infer A extends any[]
]
  ? A extends Partial<Parameters<F>>
    ? T
    : never
  : T extends AsyncFunc
    ? T
    : never;

/**
 * Maps {@link ValidTarget} over a tuple, so each element's prefix is checked
 * against its own injectable — heterogeneous targets stay independent and
 * one bad element poisons exactly its own slot. The explicit `readonly`
 * modifier keeps the mapped tuple assignable from the readonly tuples the
 * `const` type parameter of {@link invalidate} infers.
 */
export type ValidatedTargets<T extends readonly unknown[]> = {
  readonly [K in keyof T]: ValidTarget<T[K]>;
};

/** What one cache provider bound to an injectable tracks for invalidation:
 * how many `useCache` consumers are mounted (`refs`) and every args tuple
 * that flowed through their wrappers, keyed by `stableHash(args)` (the
 * structural cache-line key, latest raw tuple winning). */
type CacheBinding = {refs: number; args: Map<string, any[]>};

/**
 * Per-injectable invalidation registry — which cache providers a
 * `useCache` consumer ever bound to the injectable, and the arg tuples
 * their wrappers saw. It lives on the injectable's context like the
 * result/error stores of `base.ts`, and its lifetime IS the injectable's:
 *
 * - Bindings are permanent, so invalidation still purges entries after
 *   their consumers unmounted — a remounting consumer must never be
 *   served pre-mutation data.
 * - The tuples are kept for the same reason: a prefix target can only
 *   delete entries it can address, and `delete(args)` needs the raw
 *   tuple. They are deduped structurally, so a long session grows this
 *   with distinct queries, not with calls.
 * - `refs` gates revalidation: with no mounted consumer there is no
 *   wrapper chain to refetch through — a revalidation call would hit the
 *   raw function without caching or broadcasting — so purged-but-inactive
 *   entries are left for the next mount to fetch fresh.
 */
type CacheRegistry = Map<CacheProvider<any, any[]>, CacheBinding>;

// Module-private store key, following the store-key pattern of base.ts:
// the registry is reachable only through the helpers below.
const cacheRegistryKey = Symbol('cache registry');

/** Lazily creates and returns the invalidation registry of an injectable. */
function getCacheRegistry(fn: Func): CacheRegistry {
  // Throws the descriptive error of the inject system for plain functions —
  // invalidation targets must be injectables (the cache binding, the stores
  // and the wrapper chain all live on the injectable).
  const context = getInjectContext(fn);
  let registry = context[cacheRegistryKey] as CacheRegistry | undefined;
  if (!registry) {
    registry = new Map();
    context[cacheRegistryKey] = registry;
  }
  return registry;
}

/**
 * Binds a cache provider to an injectable for invalidation and refcounts
 * the mounted `useCache` consumers. Composed into {@link useCache} — the
 * one place where an injectable and its provider meet — so every cached
 * read is invalidatable without extra wiring.
 *
 * The binding itself is created during render (idempotent get-or-create),
 * so a mutation fired from a sibling's effect already resolves the
 * injectable to its provider. The refcount lives in an effect: mount adds,
 * StrictMode's simulated remount re-adds, unmount releases — the same
 * mount/unmount semantics every other hook here follows. The binding
 * (with its tracked tuples) outlives the consumers on purpose; only the
 * injectable's own garbage collection drops it.
 *
 * @param injectableFn the injectable `useCache` is caching
 * @param cacheProvider the provider `useCache` was given
 * @return the injectable's registry, for the wrapper's arg tracking
 */
export function useCacheInvalidation<AF extends AsyncFunc>(
  injectableFn: AF,
  cacheProvider: CacheProvider<any, any[]>
): CacheRegistry {
  const registry = getCacheRegistry(injectableFn);
  let binding = registry.get(cacheProvider);
  if (!binding) registry.set(cacheProvider, (binding = {refs: 0, args: new Map()}));
  useEffect(() => {
    binding!.refs++;
    return () => {
      binding!.refs--;
    };
    // The registry lives on the injectable's context — one object per
    // injectable — and the provider is typically module-level, so both
    // identities are stable; a changed provider simply binds alongside.
  }, [registry, cacheProvider]);
  return registry;
}

/**
 * Records an args tuple seen by a `useCache` wrapper. Keyed by
 * `stableHash(args)` — the structural key of the cache line — so repeated
 * and structurally equal calls (including fresh `AbortSignal`s, which
 * `stableHash` maps to one placeholder) collapse to the latest raw tuple.
 */
export function recordCacheArgs(
  registry: CacheRegistry,
  cacheProvider: CacheProvider<any, any[]>,
  args: any[]
): void {
  registry.get(cacheProvider)?.args.set(stableHash(args), args);
}

/** Whether `args` structurally extends `prefix`, position by position. */
function matchesPrefix(prefix: readonly any[], args: readonly any[]): boolean {
  return (
    args.length >= prefix.length &&
    prefix.every((arg, i) => stableHash(arg) === stableHash(args[i]))
  );
}

/**
 * Invalidate every matching cache entry of the given targets and revalidate
 * the queries live consumers display — the fire-and-forget counterpart of
 * TanStack Query's `queryClient.invalidateQueries`, expressed through the
 * wrapper-injection architecture instead of a global client.
 *
 * Per target:
 *
 * 1. **Purge.** A bare injectable clears every provider bound to it (bind
 *    one provider per injectable — the documented pattern — and clearing
 *    cannot hit another entity). A prefix tuple deletes exactly the
 *    tracked entries whose args structurally extend the prefix; since the
 *    `useCache` wrapper is the only writer of these entries, tracked means
 *    cached.
 * 2. **Revalidate.** The arg tuples of providers with mounted consumers
 *    are re-run through the full wrapper chain — a hard cache miss that
 *    refetches, writes the fresh result and broadcasts it to every
 *    subscriber, exactly like a focus revalidation. The shared stale flag
 *    is raised first so subscribers can render their refreshing
 *    indicator. Purged entries with no live consumer are not re-run
 *    (there is no wrapper chain to refetch through); the next mount
 *    simply fetches fresh data.
 *
 * Revalidation failures surface through the target's error store
 * (`useError`) like any other call; their promises are swallowed here so a
 * fire-and-forget `invalidate` never leaks an unhandled rejection.
 *
 * @param targets what to invalidate: each entry is an injectable (all of
 *   its cache) or an `[injectable, ...argsPrefix]` tuple (entries whose
 *   args extend the prefix)
 * @example
 * ```tsx
 * const [save] = useMutation(saveArticle, {
 *   invalidates: [fetchFeed, [fetchArticle, slug]]
 * });
 * // or imperatively, e.g. from a websocket handler:
 * invalidate([fetchFeed]);
 * ```
 */
export function invalidate<const T extends readonly unknown[]>(
  targets: T & ValidatedTargets<T>
): void {
  // The generic + validated parameter type is the public contract; inside,
  // the elements are plain targets again — the validation already happened
  // at the type level, and `Array.isArray` narrowing does not play well
  // with the deferred intersection types.
  for (const target of targets as readonly InvalidateTarget[]) {
    invalidateTarget(target);
  }
}

function invalidateTarget(target: InvalidateTarget): void {
  const [fn, prefix] = Array.isArray(target)
    ? [target[0] as AsyncFunc, target.slice(1) as any[]]
    : [target as AsyncFunc, undefined];
  // An empty tuple literal typed its head away; nothing to resolve.
  if (!fn) return;
  const registry = getCacheRegistry(fn);

  // A zero-length prefix covers any args — the same match as the bare
  // form, which clears outright instead of enumerating tuples.
  const wholeCache = prefix === undefined || prefix.length === 0;
  const refetches = new Map<string, any[]>();
  for (const [provider, binding] of registry) {
    if (wholeCache) provider.clear();
    for (const [key, args] of binding.args) {
      if (wholeCache || matchesPrefix(prefix, args)) {
        if (!wholeCache) provider.delete(args);
        // Revalidate only what live consumers display — see CacheRegistry.
        if (binding.refs > 0) refetches.set(key, args);
      }
    }
  }

  if (refetches.size > 0) {
    emitStale(getStaleStore(fn), true);
    for (const args of refetches.values()) {
      Promise.resolve(fn(...args)).catch(noop);
    }
  }
}
