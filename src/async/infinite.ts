import {AsyncFunc, Func, R} from '@@/types';
import {stableHash} from '@@/util';
import {useCallback, useState} from 'react';
import {
  emitResult,
  getResultStore,
  nextResultSeq,
  trimTrailingSignal,
  useStoreValue
} from './base';
import {useInject} from './inject';

// Pagination state keyed by the injectable itself, following the registry
// pattern of the other per-injectable stores: every useInfinite consumer
// of the same injectable shares one state, and the whole entry is released
// once the injectable is garbage-collected. `pages`/`pageParams` are
// replaced (never mutated) on every update, so the pages array identity
// doubles as the store snapshot.
type PageDir = 'next' | 'prev';

// `pendingNext`/`pendingPrev` hold the in-flight fetch of each direction:
// a second call while one is in flight would re-derive the same param from
// the same pages and append/prepend the page twice (see fetchNextPage).
//
// `paramKeys` holds the args-key of every page in the aggregation, parallel
// to `pageParams` (a trailing AbortSignal is trimmed before hashing, so a
// rerun of the same page with and without a signal compares equal) — the
// comparison anchor of `resetOn: 'args'`: a non-directional call whose
// args are among the current aggregation's pages is a rerun of a page it
// already shows and keeps the list; anything else restarts it. Unlike
// `pages`/`pageParams` it is internal-only (never a store snapshot), so it
// mutates in place instead of swapping identities.
type InfiniteState = {
  pages: any[];
  pageParams: any[];
  paramKeys: string[];
  pendingDirs: PageDir[];
  pendingNext?: Promise<any>;
  pendingPrev?: Promise<any>;
};

const infiniteStates = new WeakMap<Func, InfiniteState>();

function stateOf(fn: Func): InfiniteState {
  let state = infiniteStates.get(fn);
  if (!state) {
    state = {pages: [], pageParams: [], paramKeys: [], pendingDirs: []};
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
 * `useInfiniteQuery`: `{pages, pageParams, fetchNextPage,
 * fetchPreviousPage, isFetchingNextPage, isFetchingPreviousPage,
 * hasNextPage, hasPreviousPage}` with the same meanings, minus the parts
 * that presuppose a query-client (the `data.pages` / `data.pageParams`
 * nesting). Read pages from this hook's return value instead of
 * `useResult` — the store holds the aggregated array, not a single page.
 * `pageParams` is parallel to `pages` (index `i` holds the param that
 * fetched `pages[i]`) and reflects only the hook-driven aggregation.
 *
 * Which calls grow and which reset: a call issued through
 * `fetchNextPage()` appends its page to the end, one through
 * `fetchPreviousPage()` prepends it to the front; any other call — a
 * `useRun` rerun, a manual call, a `useFocusRevalidate` tick — RESETS
 * `pages`/`pageParams` to that single result, so a refetch naturally
 * restarts the list (at the refetched page's param) — unless
 * `resetOn: 'args'` (see below) shields it as a rerun. The first page is
 * therefore driven exactly like any other query (`useRun(fetchPages,
 * [initialParam])` or a manual call); this hook never starts requests on
 * its own. `fetchNextPage`/`fetchPreviousPage` are in-flight debounced
 * per direction: while a fetch of one direction is still in flight, later
 * calls of the SAME direction no-op (returning `undefined`, like an
 * exhausted boundary) instead of re-deriving the same param from the same
 * pages and appending/prepending the page twice — TanStack
 * `fetchNextPage`'s default in-flight behavior. The two directions stay
 * independent: a forward and a backward fetch can be in flight together.
 *
 * `resetOn` (default `'rerun'`) decides which non-directional calls reset
 * the aggregation. `'rerun'` keeps the historic contract: every one of
 * them restarts the list — right for a feed whose rerun means "the world
 * changed". `'args'` resets only when the call's args are NOT among the
 * pages the aggregation already shows: a same-args rerun — a `useCache`
 * invalidation re-running the first page (or every page), a focus
 * revalidation, a `useRun` rerun of the same args — keeps the accumulated
 * pages on screen instead of collapsing a list the user paged through,
 * while a genuinely different param (a filter change driving
 * `useRun(fetchPages, [newParam])`) still restarts it. The rerun's fresh
 * page deliberately does not enter the aggregation (it still lands in any
 * inner cache and the loading stores); pair the mode with `useCache` when
 * other consumers need invalidation-driven freshness while the paged list
 * stays put. A trailing `AbortSignal` is ignored in the comparison, so a
 * `{signal: true}` rerun of the same page counts as the same args.
 *
 * `maxPages` (default `Infinity`) caps the window: when a fetch would
 * leave more pages than that, the far end is trimmed — `fetchNextPage`
 * sheds the oldest pages, `fetchPreviousPage` the newest — keeping
 * `pages` and `pageParams` parallel. `hasNextPage`/`hasPreviousPage` are
 * derived per render from the current `pages`/`pageParams` through the
 * param callbacks, so after a trim the flag at the trimmed end flips back
 * to `true` exactly when a param can still be derived there.
 *
 * @param {AF} injectableFn - the injectable page fetcher, called as
 *   `fn(pageParam)`.
 * @param {object} options - `getNextPageParam(lastPage, allPages,
 *   lastPageParam, allPageParams)`: derives the next `pageParam` from the
 *   pages fetched so far; returning `undefined` means the end is reached
 *   (`hasNextPage` becomes `false`). Optional `getPreviousPageParam(firstPage,
 *   allPages, firstPageParam, allPageParams)` plays the same role at the
 *   front: without it `hasPreviousPage` stays `false` and
 *   `fetchPreviousPage()` is a no-op. Optional `maxPages` bounds the
 *   window as described above. Optional `resetOn` (`'rerun'` by default,
 *   `'args'` to keep the aggregation across same-args reruns) is
 *   described above.
 * @return {{pages: R<AF>[], pageParams: any[], fetchNextPage: () => Promise<R<AF>[] | undefined>, fetchPreviousPage: () => Promise<R<AF>[] | undefined>, isFetchingNextPage: boolean, isFetchingPreviousPage: boolean, hasNextPage: boolean, hasPreviousPage: boolean}} the aggregated pages and the paging controls.
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
    getNextPageParam: (
      lastPage: R<AF>,
      allPages: R<AF>[],
      lastPageParam: any,
      allPageParams: any[]
    ) => any | undefined;
    getPreviousPageParam?: (
      firstPage: R<AF>,
      allPages: R<AF>[],
      firstPageParam: any,
      allPageParams: any[]
    ) => any | undefined;
    maxPages?: number;
    resetOn?: 'rerun' | 'args';
  }
): {
  pages: R<AF>[];
  pageParams: any[];
  fetchNextPage: () => Promise<R<AF>[] | undefined>;
  fetchPreviousPage: () => Promise<R<AF>[] | undefined>;
  isFetchingNextPage: boolean;
  isFetchingPreviousPage: boolean;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
} {
  const {getNextPageParam, getPreviousPageParam} = options;
  // A floor of 1 keeps the window non-empty (0 would trim every fetch
  // away and leave nothing to derive further params from). Infinity —
  // the default — keeps the pre-maxPages behavior: pages only ever grow.
  const maxPages = Math.max(1, options.maxPages ?? Infinity);
  // 'rerun' keeps the historic contract: EVERY non-directional call resets
  // the aggregation. 'args' shields reruns of pages the aggregation
  // already shows (see paramKeys).
  const resetOn = options.resetOn ?? 'rerun';
  const store = getResultStore(injectableFn);
  const state = stateOf(injectableFn);

  useInject(
    injectableFn,
    (f: AF, callContext: any) =>
      ((...args: Parameters<AF>) => {
        // Decide the call's direction exactly once and publish the
        // verdict on the callContext, which every wrapper of the same call
        // shares: with several useInfinite consumers registered on one
        // injectable, the outermost wrapper consumes the queued direction
        // and the inner ones read the same verdict instead of re-deciding
        // (and disagreeing). The deciding wrapper's maxPages and resetOn
        // ride along, so trim, reset semantics, and verdict always come
        // from one consumer's options.
        let verdict = callContext.infiniteVerdict;
        if (!verdict) {
          // FIFO: with a forward and a backward fetch in flight at once,
          // each settling call consumes the mark queued for it in issue
          // order.
          const dir = state.pendingDirs.shift() ?? null;
          verdict = callContext.infiniteVerdict = {
            dir,
            maxPages,
            resetOn,
            done: false
          };
        }
        return f(...args).then((page: R<AF>) => {
          // Exactly one wrapper of this call updates the shared state.
          if (verdict.done) return state.pages;
          verdict.done = true;
          const param = args[0];
          // The aggregation-membership key of this call: the args tuple
          // with a trailing AbortSignal trimmed, so a rerun issued with a
          // signal (a useRun {signal: true} rerun, an invalidation replay)
          // compares equal to the page's original call.
          const key = stableHash(trimTrailingSignal(args));
          if (verdict.dir === 'next') {
            state.pages = [...state.pages, page];
            state.pageParams = [...state.pageParams, param];
            state.paramKeys.push(key);
          } else if (verdict.dir === 'prev') {
            state.pages = [page, ...state.pages];
            state.pageParams = [param, ...state.pageParams];
            state.paramKeys.unshift(key);
          } else if (
            verdict.resetOn !== 'args' ||
            !state.paramKeys.includes(key)
          ) {
            // Any other call resets the aggregation to the single result —
            // except in 'args' mode, where a call whose args match a page
            // the aggregation already shows is a rerun (an invalidation
            // re-running the first page — or every page — a focus
            // revalidation, a useRun rerun of the same args) and the
            // accumulated pages stay: collapsing a list the user paged
            // through is the surprising behavior the mode opts out of. The
            // rerun's fresh page deliberately does NOT enter the
            // aggregation — it still lands wherever inner wrappers put it
            // (a useCache entry, the loading stores); restarting the list
            // stays the job of a call with args outside the aggregation.
            state.pages = [page];
            state.pageParams = [param];
            state.paramKeys = [key];
          }
          if (state.pages.length > verdict.maxPages) {
            // Trim from the far end: a forward fetch sheds the oldest
            // pages, a backward fetch the newest — the window over the
            // list moves with the fetching direction.
            const drop = state.pages.length - verdict.maxPages;
            const head = verdict.dir === 'prev' ? 0 : drop;
            state.pages = state.pages.slice(head, head + verdict.maxPages);
            state.pageParams = state.pageParams.slice(
              head,
              head + verdict.maxPages
            );
            state.paramKeys.splice(head, drop);
          }
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
  // result the shared state's initial [] shows. A non-array `lastResult`
  // is a single-page emission an inner wrapper made for a call still
  // bubbling to this wrapper's aggregation emission (a useCache publish
  // resolves one microtask earlier) or an inner cache-hit replay that never
  // reaches this wrapper at all — either way the aggregation, not that
  // page, is what this hook renders, so the shared state's pages stand in
  // until the aggregated array takes the store back.
  const pages = useStoreValue(
    store,
    useCallback(
      () =>
        store.hasResult && Array.isArray(store.lastResult)
          ? store.lastResult
          : state.pages,
      [store, state]
    )
  );
  // pageParams is swapped in the same synchronous block that emits pages,
  // so reading the shared state here stays parallel to the rendered pages
  // (it only tracks the hook-driven aggregation — a cached single-page
  // result replayed into the store has no params to show).
  const pageParams = state.pageParams;

  const [isFetchingNextPage, setFetchingNextPage] = useState(false);
  const fetchNextPage = useCallback(async (): Promise<R<AF>[] | undefined> => {
    // In-flight debounce: a rapid second click (or a second consumer of
    // the same injectable) re-derives the SAME param from the same pages,
    // queues a second 'next' mark, and the FIFO verdict appends the page
    // twice. While a forward fetch is in flight, later calls no-op —
    // TanStack `fetchNextPage`'s default in-flight behavior.
    if (state.pendingNext) return undefined;
    const current = state.pages;
    const params = state.pageParams;
    const next = current.length
      ? getNextPageParam(
          current[current.length - 1],
          current,
          params[params.length - 1],
          params
        )
      : undefined;
    if (next === undefined) return undefined;
    // Mark the upcoming call as a forward append; the wrapper above
    // consumes the mark when the call flows through it.
    state.pendingDirs.push('next');
    setFetchingNextPage(true);
    const call = injectableFn(next as Parameters<AF>[0]) as Promise<R<AF>[]>;
    state.pendingNext = call;
    try {
      return await call;
    } finally {
      state.pendingNext = undefined;
      setFetchingNextPage(false);
    }
  }, [injectableFn, getNextPageParam, state]);

  const [isFetchingPreviousPage, setFetchingPreviousPage] = useState(false);
  const fetchPreviousPage = useCallback(async (): Promise<
    R<AF>[] | undefined
  > => {
    // Without the option there is no way to derive an earlier param —
    // stay a no-op, like fetchNextPage at the end of the list.
    if (!getPreviousPageParam) return undefined;
    // In-flight debounce, mirroring fetchNextPage (see the comment
    // there): a backward fetch in flight makes later calls no-op instead
    // of prepending the same page twice.
    if (state.pendingPrev) return undefined;
    const current = state.pages;
    const params = state.pageParams;
    const prev = current.length
      ? getPreviousPageParam(current[0], current, params[0], params)
      : undefined;
    if (prev === undefined) return undefined;
    // Mark the upcoming call as a backward prepend; the wrapper above
    // consumes the mark when the call flows through it.
    state.pendingDirs.push('prev');
    setFetchingPreviousPage(true);
    const call = injectableFn(prev as Parameters<AF>[0]) as Promise<R<AF>[]>;
    state.pendingPrev = call;
    try {
      return await call;
    } finally {
      state.pendingPrev = undefined;
      setFetchingPreviousPage(false);
    }
  }, [injectableFn, getPreviousPageParam, state]);

  // Both flags are derived per render, never stored: after a maxPages
  // trim the new boundary page can suddenly have a derivable neighbor,
  // and the flag must follow without waiting for another fetch.
  const hasNextPage =
    pages.length > 0 &&
    getNextPageParam(
      pages[pages.length - 1],
      pages,
      pageParams[pageParams.length - 1],
      pageParams
    ) !== undefined;

  const hasPreviousPage =
    pages.length > 0 &&
    getPreviousPageParam !== undefined &&
    getPreviousPageParam(pages[0], pages, pageParams[0], pageParams) !==
      undefined;

  return {
    pages,
    pageParams,
    fetchNextPage,
    fetchPreviousPage,
    isFetchingNextPage,
    isFetchingPreviousPage,
    hasNextPage,
    hasPreviousPage
  };
}
