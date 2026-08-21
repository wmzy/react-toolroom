import {AsyncFunc, Func, R} from '@@/types';
import {useCallback, useState} from 'react';
import {emitResult, getResultStore, nextResultSeq, useStoreValue} from './base';
import {useInject} from './inject';

// Pagination state keyed by the injectable itself, following the registry
// pattern of dedup.ts: every useInfinite consumer of the same injectable
// shares one state, and the whole entry is released once the injectable is
// garbage-collected. `pages` is replaced (never mutated) on every update,
// so the array identity doubles as the store snapshot.
type InfiniteState = {pages: any[]; appendPending: number};

const infiniteStates = new WeakMap<Func, InfiniteState>();

function stateOf(fn: Func): InfiniteState {
  let state = infiniteStates.get(fn);
  if (!state) {
    state = {pages: [], appendPending: 0};
    infiniteStates.set(fn, state);
  }
  return state;
}

/**
 * Infinite (paginated) loading for an injectable whose fetcher takes a
 * single `pageParam` argument (`(pageParam) => Promise<page>`). The hook
 * aggregates the fetched pages into an array and publishes that array to
 * the injectable's result store, so every consumer stays in sync.
 *
 * The returned shape is a deliberate subset of TanStack Query's
 * `useInfiniteQuery`: `{pages, fetchNextPage, isFetchingNextPage,
 * hasNextPage}` with the same meanings, minus the parts that presuppose
 * a query-client (the `data.pages` / `data.pageParams` nesting and
 * direction-based fetching). Read pages from this hook's return value
 * instead of `useResult` — the store holds the aggregated array, not a
 * single page.
 *
 * Which calls append and which reset: a call issued through
 * `fetchNextPage()` appends its page; any other call — a `useRun` rerun,
 * a manual call, a `useFocusRevalidate` tick — RESETS `pages` to that
 * single result, so a refetch naturally restarts the list. The first page
 * is therefore driven exactly like any other query (`useRun(fetchPages,
 * [initialParam])` or a manual call); this hook never starts requests on
 * its own.
 *
 * @param {AF} injectableFn - the injectable page fetcher, called as
 *   `fn(pageParam)`.
 * @param {object} options - `getNextPageParam(lastPage, allPages)`: derives
 *   the next `pageParam` from the pages fetched so far; returning
 *   `undefined` means the end is reached (`hasNextPage` becomes `false`).
 * @return {{pages: R<AF>[], fetchNextPage: () => Promise<R<AF>[] | undefined>, isFetchingNextPage: boolean, hasNextPage: boolean}} the aggregated pages and the paging controls.
 * @example
 * ```tsx
 * const fetchProjects = useInjectable(
 *   (cursor: number | undefined) => api.projects(cursor)
 * );
 * const {pages, fetchNextPage, isFetchingNextPage, hasNextPage} = useInfinite(
 *   fetchProjects,
 *   {getNextPageParam: (lastPage) => lastPage.nextCursor}
 * );
 * // First page on mount; a rerun of useRun resets `pages`.
 * useRun(fetchProjects, [undefined]);
 *
 * return (
 *   <>
 *     {pages.flatMap((page) => page.items).map((p) => (
 *       <Card key={p.id} item={p} />
 *     ))}
 *     <button
 *       type='button'
 *       disabled={!hasNextPage || isFetchingNextPage}
 *       onClick={() => void fetchNextPage()}
 *     >
 *       {isFetchingNextPage ? 'Loading…' : hasNextPage ? 'Load more' : 'End'}
 *     </button>
 *   </>
 * );
 * ```
 */
export function useInfinite<AF extends AsyncFunc>(
  injectableFn: AF,
  options: {
    getNextPageParam: (lastPage: R<AF>, allPages: R<AF>[]) => any | undefined;
  }
): {
  pages: R<AF>[];
  fetchNextPage: () => Promise<R<AF>[] | undefined>;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
} {
  const {getNextPageParam} = options;
  const store = getResultStore(injectableFn);
  const state = stateOf(injectableFn);

  useInject(
    injectableFn,
    (f: AF, callContext: any) =>
      ((...args: Parameters<AF>) => {
        // Decide append-vs-reset exactly once per call and publish the
        // verdict on the callContext, which every wrapper of the same call
        // shares: with several useInfinite consumers registered on one
        // injectable, the outermost wrapper consumes the pending-append
        // count and the inner ones read the same verdict instead of
        // re-deciding (and disagreeing).
        let verdict = callContext.infiniteVerdict;
        if (!verdict) {
          const append = state.appendPending > 0;
          if (append) state.appendPending--;
          verdict = callContext.infiniteVerdict = {append, done: false};
        }
        return f(...args).then((page: R<AF>) => {
          // Exactly one wrapper of this call updates the shared state.
          if (verdict.done) return state.pages;
          verdict.done = true;
          state.pages = verdict.append ? [...state.pages, page] : [page];
          // The fresh ticket is reserved at RESOLVE time, not at call time:
          // this emission must win over any single-page emission an inner
          // wrapper (useResult, useCache) makes for the same call, whatever
          // ticket order their registration produced.
          emitResult(store, state.pages, nextResultSeq(store));
          return state.pages;
        });
      }) as AF
  );

  // The pages array is swapped (never mutated) on each update, so it is a
  // naturally stable snapshot for useSyncExternalStore; before the first
  // result the shared state's initial [] shows.
  const pages = useStoreValue(
    store,
    useCallback(
      () => (store.hasResult ? store.lastResult : state.pages),
      [store, state]
    )
  );

  const [isFetchingNextPage, setFetchingNextPage] = useState(false);
  const fetchNextPage = useCallback(async (): Promise<R<AF>[] | undefined> => {
    const current = state.pages;
    const next = current.length
      ? getNextPageParam(current[current.length - 1], current)
      : undefined;
    if (next === undefined) return undefined;
    // Mark the upcoming call as an append; the wrapper above consumes the
    // mark when the call flows through it.
    state.appendPending++;
    setFetchingNextPage(true);
    try {
      return await (injectableFn(next as Parameters<AF>[0]) as Promise<
        R<AF>[]
      >);
    } finally {
      setFetchingNextPage(false);
    }
  }, [injectableFn, getNextPageParam, state]);

  const hasNextPage =
    pages.length > 0 &&
    getNextPageParam(pages[pages.length - 1], pages) !== undefined;

  return {pages, fetchNextPage, isFetchingNextPage, hasNextPage};
}
