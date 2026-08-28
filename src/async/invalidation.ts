import {AsyncFunc, CacheProvider, Func} from '@@/types';
import {noop, stableHash} from '@@/util';
import {emitStale, getStaleStore} from './base';
import {getInjectContext} from './inject';

/**
 * One declarative invalidation target:
 * - a bare cache provider — its whole cache is purged, or
 * - a `[provider, ...argsPrefix]` tuple — only entries whose raw args tuple
 *   structurally extends the prefix, so `[feedCache, 'news']` leaves the
 *   `sports` entries alone.
 *
 * The prefix elements are checked element-wise against the provider's raw
 * key tuples (`deleteWhere`), so any `hash` convention works — matching
 * happens in args space, never in hashed-key space.
 */
export type InvalidateTarget = CacheProvider<any, any[]>;

/**
 * Validates one element of an `invalidates` array: a cache provider alone,
 * or a `[provider, ...prefix]` tuple whose prefix is assignable to the
 * provider's key tuple. An invalid element collapses to `never`, so the
 * containing array rejects the literal at compile time.
 */
type ValidTarget<T> = T extends readonly [infer P, ...infer A extends any[]]
  ? P extends CacheProvider<any, infer K extends any[]>
    ? A extends Partial<K>
      ? T
      : never
    : never
  : // The bare-provider branch matches any key tuple: `K` is invariant in
    // `CacheProvider` (function-valued members use it in both parameter and
    // output positions), so a concrete `CacheProvider<string, [string]>`
    // does not extend `CacheProvider<any, any[]>` even though every
    // concrete tuple does extend `any[]`.
    T extends CacheProvider<any, infer K extends any[]>
    ? T
    : never;

/**
 * Maps {@link ValidTarget} over a tuple, so each element's prefix is checked
 * against its own provider's key tuple.
 */
export type ValidatedTargets<T extends readonly unknown[]> = {
  readonly [K in keyof T]: ValidTarget<T[K]>;
};

/** Runtime shape check of an invalidation target's head. */
export function isCacheProvider(
  value: any
): value is CacheProvider<any, any[]> {
  return (
    !!value &&
    typeof value.delete === 'function' &&
    typeof value.clear === 'function'
  );
}

/** Whether `args` structurally extends `prefix`, position by position. */
function matchesPrefix(prefix: readonly any[], args: readonly any[]): boolean {
  return (
    args.length >= prefix.length &&
    prefix.every((arg, i) => stableHash(arg) === stableHash(args[i]))
  );
}

/**
 * Per-injectable, per-provider set of structurally-keyed revalidations in
 * flight — the dedup that keeps one delete event from N mounted `useCache`
 * consumers (or from `useInvalidate`'s explicit follow-up call) triggering N
 * refetches of the same args. Lives on the injectable's context like the
 * stores of `base.ts`; entries are removed when the revalidation settles.
 * Keyed by provider identity alone — the key type is `object` because the
 * registry serves providers of any args-tuple type.
 */
type PendingRegistry = Map<object, Set<string>>;

// Module-private store key, following the store-key pattern of base.ts.
const pendingKey = Symbol('revalidation pending');

/** Lazily creates and returns the pending set of an injectable×provider pair. */
export function getPendingSet<K extends any[]>(
  fn: Func,
  cacheProvider: CacheProvider<any, K>
): Set<string> {
  const context = getInjectContext(fn);
  let registry = context[pendingKey] as PendingRegistry | undefined;
  if (!registry) {
    registry = new Map();
    context[pendingKey] = registry;
  }
  let pending = registry.get(cacheProvider);
  if (!pending) registry.set(cacheProvider, (pending = new Set()));
  return pending;
}

const observedKey = Symbol('useCache observed args');

/**
 * Lazily creates and returns the observed-args set of an injectable×provider
 * pair — the hashed tuples a mounted `useCache` consumer currently watches.
 * Passive revalidation consults it: a deletion of an observed entry is the
 * provider's GC collecting a live entry, not invalidation, so re-running it
 * would start a perpetual refetch loop (delete → refetch → delete → …).
 * Instead the observation is refreshed and nothing re-runs.
 */
export function getObservedSet<K extends any[]>(
  fn: Func,
  cacheProvider: CacheProvider<any, K>
): Set<string> {
  const context = getInjectContext(fn);
  let registry = context[observedKey] as PendingRegistry | undefined;
  if (!registry) {
    registry = new Map();
    context[observedKey] = registry;
  }
  let observed = registry.get(cacheProvider);
  if (!observed) registry.set(cacheProvider, (observed = new Set()));
  return observed;
}

/**
 * Subscribes a `useCache` consumer to its provider's deletion events — the
 * passive half of the invalidation model. Whenever entries are removed
 * (`delete`/`clear`/`deleteWhere`/`deletePrefix`/expiry), every tuple this
 * consumer's wrapper has seen among them is re-run through the injectable's
 * full wrapper chain: a hard cache miss that refetches, writes the fresh
 * result and broadcasts it to every subscriber, exactly like a focus
 * revalidation. The shared stale flag is raised first so subscribers can
 * render their refreshing indicator.
 *
 * `seen` is the consumer's own Map of structurally-keyed args tuples — owned
 * by the hook instance, dropped with it on unmount, so a departed consumer's
 * queries are never re-run by a later event. Cross-consumer dedup happens
 * through {@link getPendingSet}.
 *
 * Providers without the optional `subscribe` member get no passive
 * revalidation: entries still purge, and the next wrapper-driven call
 * (remount, manual call) fetches fresh — matching the pre-observable
 * provider contract.
 *
 * @return an unsubscribe function
 */
export function bindCacheRevalidation<K extends any[]>(
  injectableFn: AsyncFunc,
  cacheProvider: CacheProvider<any, K>,
  seen: Map<string, any[]>
): () => void {
  return (
    cacheProvider.subscribe?.((e) => {
      if (e.type !== 'delete') return;
      const pending = getPendingSet(injectableFn, cacheProvider);
      const hits: any[][] = [];
      for (const args of e.deleted) {
        const key = stableHash(args);
        if (seen.has(key) && !pending.has(key)) hits.push(args);
      }
      if (hits.length === 0) return;
      // GC-exempt entries are never deleted by the sweep (they are never in
      // `e.deleted`), so every deletion that reaches here is a real
      // invalidation — purge-and-refetch runs exactly as before. The
      // observed-set below only repairs bookkeeping when a deletion races a
      // revalidation's own settle.
      const observed = getObservedSet(injectableFn, cacheProvider);
      emitStale(getStaleStore(injectableFn), true);
      for (const args of hits) {
        // The deleted entry may carry a stale observation record (deleted →
        // refetch rewrote it). Re-mark so the refetch's fresh entry stays
        // exempt while the consumer remains mounted.
        if (observed.has(stableHash(args))) {
          (cacheProvider.observe as (a: any[][], on: boolean) => void)?.([args], true);
        }
        pending.add(stableHash(args));
        // Fire-and-forget like the old active revalidation: failures surface
        // through the target's error store (useError), never as an unhandled
        // rejection on the mutating call's promise.
        Promise.resolve(injectableFn(...args))
          .catch(noop)
          .finally(() => pending.delete(stableHash(args)));
      }
    }) ?? noop
  );
}

/**
 * Purge the caches addressed by the given targets — the imperative,
 * mutation-agnostic half of the invalidation model (the `invalidates` option
 * of `useMutation` calls exactly this on success).
 *
 * Per target: a bare provider clears outright; a `[provider, ...argsPrefix]`
 * tuple removes only the entries whose raw args tuple structurally extends
 * the prefix, via the provider's `deleteWhere` (entries whose tuple the
 * provider cannot recover — SSR hydration — are skipped).
 *
 * This is a pure cache operation: it touches no injectable, needs no
 * mounted consumer and never issues a request. Refreshing what mounted
 * `useCache` consumers display is the provider's own event and
 * {@link bindCacheRevalidation}'s job — which is why `deletePrefix`, a
 * devtools panel button or any other writer gets the same revalidation for
 * free.
 *
 * @param targets what to purge: each entry is a cache provider (all of it)
 *   or a `[provider, ...argsPrefix]` tuple (entries whose args extend the
 *   prefix)
 * @example
 * ```tsx
 * const [save] = useMutation(saveArticle, {
 *   invalidates: [feedCache, [articleCache, slug]]
 * });
 * // or imperatively, e.g. from a websocket handler:
 * invalidate([feedCache]);
 * ```
 */
export function invalidate<const T extends readonly unknown[]>(
  targets: T & ValidatedTargets<T>
): void {
  // The generic + validated parameter type is the public contract; inside,
  // the elements are plain targets again — the validation already happened
  // at the type level, and `Array.isArray` narrowing does not play well
  // with the deferred intersection types.
  for (const target of targets as readonly (
    | CacheProvider<any, any[]>
    | readonly any[]
  )[]) {
    const [provider, prefix] = Array.isArray(target)
      ? [target[0] as CacheProvider<any, any[]>, target.slice(1) as any[]]
      : [target as CacheProvider<any, any[]>, undefined];
    if (!isCacheProvider(provider)) {
      throw new Error(
        'invalidate expects cache providers (optionally as ' +
          '[provider, ...argsPrefix] tuples), got something else.'
      );
    }
    if (prefix === undefined || prefix.length === 0) {
      provider.clear();
    } else if (provider.deleteWhere) {
      provider.deleteWhere((args) => matchesPrefix(prefix, args));
    } else if (process.env.NODE_ENV !== 'production') {
      console.error(
        'invalidate: prefix targets need a provider implementing ' +
          'deleteWhere() (createMemoryCacheProvider does); the target was ' +
          'skipped.'
      );
    }
  }
}
