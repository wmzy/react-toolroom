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
 * The recipe one cache-bound mutation is built from. Produced per call from
 * the call arguments, so keys and projections can be derived from them.
 */
export type MutationSpec<T, K extends any[], Args extends any[], Resp> = {
  /**
   * The effectful call — zero-arg: the spec callback already closed over
   * everything it needs. Compose layers by putting another cache's bound
   * mutation here (it runs its own optimistic pipeline; a rejection
   * unwinds every layer).
   */
  mutate: () => Promise<Resp>;
  /**
   * Addresses the single entry this mutation owns. Omit it when the
   * mutation patches projections living across many entries — `update`
   * and `apply` then run over every settled entry (miss-bailing each).
   */
  key?: K | ((...args: Args) => K);
  /**
   * The optimistic first step, run synchronously before `mutate`: receives
   * the current cached value and the call arguments, returns the next
   * value. Entries without a settled baseline are skipped (nothing is
   * fabricated), and returning `undefined`/`void` keeps the entry as-is.
   * Omit for no optimistic step.
   */
  update?: (old: T, ...args: Args) => T | void;
  /**
   * Merges the resolved response into the cache on success. Must be
   * field-selecting — the response was captured when the request started,
   * so wholesale spreading can roll back fields another writer patched
   * while the request was in flight. Same addressing and miss-bail rules
   * as `update`; omit to leave the cache to the optimistic value.
   */
  apply?: (old: T, resp: Resp, ...args: Args) => T | void;
};

/** What `cache.mutation(spec)` hands back: the plain callable pipeline. */
export type BoundMutation<Args extends any[], Resp> = (
  ...args: Args
) => Promise<Resp>;

/**
 * The standalone flavor of `cache.mutation`, for providers that predate the
 * member or composition over a provider handled elsewhere.
 */
export type CreateMutationBinder<T, K extends any[]> = {
  mutation: <Args extends any[], Resp>(
    spec: (...args: Args) => MutationSpec<T, K, Args, Resp>
  ) => BoundMutation<Args, Resp>;
};

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
  // (`if (provider.load) …`) instead of assuming they exist.
  /**
   * Atomic get-or-insert of the in-flight slot: if a request for `k` is
   * already pending, its promise is returned and `factory` is NOT invoked;
   * otherwise `factory()` runs once and its promise is registered, so every
   * concurrent consumer (and every channel — another injectable, a router
   * loader) shares one request. On settle the provider writes the result
   * back itself — unless a write (`set`/`delete`/…) touched the key while
   * the request was in flight, in which case the late response is dropped
   * instead of clobbering the newer value. A rejection vacates the slot,
   * keeps any previously settled data and rethrows as-is.
   */
  load?: (k: K, factory: () => Promise<T>) => Promise<T>;
  /**
   * Reads the settled entry for `k` — `{value, cachedAt}` or `undefined` —
   * without observing in-flight requests and without ever creating one.
   */
  peek?: (k: K) => {value: T; cachedAt: number} | undefined;
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
  /**
   * Batch write-side primitive, the symmetric twin of `deleteWhere`: every
   * settled entry whose raw args tuple satisfies `predicate` is passed to
   * `updater`, and the returned value is written back through the same
   * entry (generation bump + one batched `set` event). Entries without a
   * recorded tuple or settled half are skipped; an updater returning
   * `undefined` (or `void`) leaves its entry untouched. Returns what was
   * written, so composite callers (e.g. {@link CacheProvider.mutation}) can
   * snapshot the pre-values for rollback.
   */
  patchWhere?: (
    predicate: (k: K) => boolean,
    updater: (value: T, k: K) => T | void
  ) => {args: K; prev: T; next: T}[];
  /**
   * Builds an optimistic mutation bound to this cache. The spec callback
   * receives the call arguments and returns {@link MutationSpec}; the bound
   * function runs the whole optimistic pipeline — see {@link MutationSpec}
   * for the exact semantics.
   */
  mutation?: CreateMutationBinder<T, K>['mutation'];
  /** Notifies `listener` after any entry mutation; returns an unsubscribe. */
  subscribe?: (listener: (e: CacheEvent<K>) => void) => () => void;
  /** Shallow-copies every settled entry as {key, value, cachedAt} for read-only observation; entries with a request in flight carry an additive `pending: true`. */
  snapshot?: () => {
    key: string;
    value: T;
    cachedAt: number;
    pending?: boolean;
  }[];
};
