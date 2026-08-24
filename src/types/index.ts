export type Func = (...args: any[]) => any;
export type AsyncFunc = (...args: any[]) => Promise<any>;
export type Unwrap<T> = T extends Promise<infer A> ? A : T;
export type R<AF extends AsyncFunc> = Unwrap<ReturnType<AF>>;
// export type Void<F extends AsyncFunc> = F extends (...args: infer P) => Promise<any> ? (...args: P) => Promise<void> : never;
export type Void<AF extends AsyncFunc> = (
  ...args: Parameters<AF>
) => Promise<void>;

export type CacheResult<T> = [T, number] | undefined;

/**
 * What a cache provider tells its listeners about one mutation. `set` fires
 * after an entry was written (`set`/`hydrate`); `delete` fires after entries
 * were removed (`delete`/`clear`/`deleteWhere`/`deletePrefix`/expiry) and
 * carries the raw args tuples of the removed entries. Entries whose raw
 * tuple the provider cannot recover (SSR `hydrate` writes only store the
 * hashed key) are omitted from `deleted` — a `useCache` subscriber has only
 * ever seen entries written through its own wrapper, so it always finds its
 * own tuples there.
 */
export type CacheEvent<K extends any[] = any[]> =
  | {type: 'set'}
  | {type: 'delete'; deleted: readonly K[]};

export type CacheProvider<T, K extends any[]> = {
  set: (k: K, v: T) => void;
  get: (k: K) => Promise<CacheResult<T>> | CacheResult<T>;
  delete: (k: K) => void;
  clear: () => void;
  use: () => () => void;
  // The members below are optional so existing custom providers (localStorage,
  // IndexedDB, no-op stubs, …) keep compiling and stay semantically valid —
  // only the memory provider ships them. Callers must feature-detect
  // (`if (provider.dehydrate) …`) instead of assuming they exist.
  /** Serializes every entry into a JSON-safe plain object, for SSR transport. */
  dehydrate?: () => Record<string, [T, number]>;
  /** Merges entries produced by `dehydrate` back in; never clears existing ones. */
  hydrate?: (data: Record<string, [T, number]>) => void;
  /** Deletes every entry whose hashed key starts with `prefix`. */
  deletePrefix?: (prefix: string) => void;
  /**
   * Deletes every entry whose raw args tuple satisfies `predicate`; entries
   * without a recorded tuple (SSR hydration) are skipped. This is the
   * addressing primitive of `[provider, ...argsPrefix]` invalidation targets.
   */
  deleteWhere?: (predicate: (k: K) => boolean) => void;
  /** Notifies `listener` after any entry mutation; returns an unsubscribe. */
  subscribe?: (listener: (e: CacheEvent<K>) => void) => () => void;
  /** Shallow-copies every entry as {key, value, cachedAt} for read-only observation. */
  snapshot?: () => {key: string; value: T; cachedAt: number}[];
};
