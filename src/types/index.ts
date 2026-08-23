export type Func = (...args: any[]) => any;
export type AsyncFunc = (...args: any[]) => Promise<any>;
export type Unwrap<T> = T extends Promise<infer A> ? A : T;
export type R<AF extends AsyncFunc> = Unwrap<ReturnType<AF>>;
// export type Void<F extends AsyncFunc> = F extends (...args: infer P) => Promise<any> ? (...args: P) => Promise<void> : never;
export type Void<AF extends AsyncFunc> = (
  ...args: Parameters<AF>
) => Promise<void>;

export type CacheResult<T> = [T, number] | undefined;

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
  /** Notifies `listener` after any entry mutation; returns an unsubscribe. */
  subscribe?: (listener: () => void) => () => void;
  /** Shallow-copies every entry as {key, value, cachedAt} for read-only observation. */
  snapshot?: () => {key: string; value: T; cachedAt: number}[];
};
