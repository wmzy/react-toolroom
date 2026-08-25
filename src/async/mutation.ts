import {BoundMutation, CacheProvider, MutationSpec} from '@@/types';

/**
 * The optimistic pipeline behind `cache.mutation(spec)`. Layers, in order:
 *
 * 1. **Optimistic first step** — `update` runs synchronously before the
 *    call, over the entry addressed by `key` or (when `key` is omitted)
 *    every settled entry via `patchWhere`. Entries without a settled
 *    baseline are skipped: nothing is fabricated, so an optimistic write
 *    can never resurrect an entry a logout just cleared. Every write is
 *    journaled (`prev` + `written`).
 * 2. **The call** — `mutate(...args)` runs as-is; composing it with another
 *    cache's bound mutation nests that layer's own pipeline here.
 * 3. **Success** — `apply` merges the response, re-addressing at settle
 *    time: it receives the *current* cached value, so fields another writer
 *    patched while the request was in flight survive a field-selecting
 *    merge. Then the response resolves the caller's promise.
 * 4. **Failure** — the journal is rolled back with a reference-equality
 *    guard: an entry is restored to `prev` only when it still holds exactly
 *    the `written` value (nobody wrote meanwhile — a concurrent writer's
 *    state is newer and stays). The rejection keeps traveling, so
 *    `useMutation`'s error bookkeeping still observes it.
 *
 * Writes go through `set`/`patchWhere`, so generation guards, subscribers
 * (devtools, loader refresh) and `useCache` consumers all see them — no
 * side channel exists to bypass. Requires `peek` and `set` (plus
 * `patchWhere` when a spec omits `key`) — the memory provider always has
 * them.
 *
 * @param {CacheProvider<T, K>} cache - The provider the spec addresses.
 * @return {CreateMutationBinder<T, K>} The `mutation` method — call it with
 *   a spec callback to get a bound mutation.
 * @example
 * ```tsx
 * const favorite = articleCache.mutation((slug: string, on: boolean) => ({
 *   mutate: () => api.favorite(slug, on),
 *   key: [slug],
 *   update: (old) => ({...old, favorited: on}),
 *   apply: (old, resp) => ({...old, favorited: resp.favorited, count: resp.count})
 * }));
 * const [run] = useMutation(favorite); // isMutating/error come free
 * ```
 */
export default function createMutationBinder<T, K extends any[]>(
  cache: CacheProvider<T, K>
): {
  mutation: <Args extends any[], Resp>(
    spec: (...args: Args) => MutationSpec<T, K, Args, Resp>
  ) => BoundMutation<Args, Resp>;
} {
  return {
    mutation<Args extends any[], Resp>(
      spec: (...args: Args) => MutationSpec<T, K, Args, Resp>
    ): BoundMutation<Args, Resp> {
      const run = async (...args: Args): Promise<any> => {
        const {mutate, key, update, apply} = spec(...args);
        const keyTuple =
          key === undefined
            ? undefined
            : typeof key === 'function'
              ? key(...args)
              : key;
        // One journal row per entry this pipeline wrote; `written` is
        // compared by identity at rollback so a concurrent writer's newer
        // state survives ours.
        const journal: {k: K; prev: T; written: T}[] = [];
        const target = (fn: (old: T) => T | void) => {
          if (keyTuple !== undefined) {
            const old = cache.peek!(keyTuple)?.value;
            if (old === undefined) return;
            const next = fn(old);
            if (next !== undefined) {
              cache.set(keyTuple, next);
              journal.push({k: keyTuple, prev: old, written: next});
            }
          } else {
            for (const {args: k, prev, next} of cache.patchWhere!(
              () => true,
              (old) => fn(old)
            )) {
              journal.push({k, prev, written: next});
            }
          }
        };
        if (update) target((old) => update(old, ...args));
        let resp: Resp;
        try {
          resp = await mutate();
        } catch (e) {
          for (const {k, prev, written} of journal) {
            if (cache.peek!(k)?.value === written) cache.set(k, prev);
          }
          throw e;
        }
        if (apply) target((old) => apply(old, resp, ...args));
        return resp;
      };
      return run;
    }
  };
}
