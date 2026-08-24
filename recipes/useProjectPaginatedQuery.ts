/**
 * Project-level query hook template — the paginated version.
 *
 * Same "copy me and customize" contract as `useProjectQuery.ts`, shaped for
 * page-keyed queries. Two behaviors worth understanding before editing:
 *
 * - Keep-previous-data is the DEFAULT: the shared result store is never
 *   reset between calls and a sequence ticket drops any result older than
 *   the latest applied one, so paging shows the old page until the new one
 *   lands (TanStack needs `placeholderData: keepPreviousData` for this).
 *   That is why this template returns BOTH loading flags: `initialLoading`
 *   for the first-screen skeleton, `loading` for a small per-page
 *   "refreshing…" indicator. `isPlaceholderData` makes the kept data
 *   observable — `true` while the rows on screen belong to the previous
 *   page (or to the optional `placeholderData` before the first page ever
 *   lands), so the table can dim instead of skeletoning.
 * - `{hash: stableHash}` makes `useRun` compare the args tuple
 *   structurally instead of by reference, so the inline `{page, pageSize}`
 *   object only re-runs the query when a value inside it actually changes.
 *
 * The demo list service is not paginated, so `fetchProjectPage` slices the
 * full list client-side purely as a stand-in — replace it with your real
 * paginated endpoint when copying (and keep the `{page, ...}` arg shape so
 * the hash and the keep-previous behavior keep working).
 */

import {
  useInitialLoading,
  useInjectable,
  useLoading,
  usePlaceholderData,
  useResult,
  useRun,
  stableHash,
  type R
} from 'react-toolroom/async';
import {fetchList} from '@/services/user';

type Project = R<typeof fetchList>;

/** The keyed query argument — hashed structurally by `useRun` below. */
type PageQuery = {page: number; pageSize: number};

/**
 * Stand-in for a real paginated endpoint: fetches everything, then slices
 * the requested page (1-based). Swap for your API when copying.
 */
async function fetchProjectPage(query: PageQuery): Promise<Project> {
  const all = await fetchList();
  const start = (query.page - 1) * query.pageSize;
  return all.slice(start, start + query.pageSize);
}

/** What `useProjectPaginatedQuery` hands to your components. */
export type ProjectPaginatedQueryResult = {
  data: Project | undefined;
  /**
   * `true` while `data` is a placeholder — the previous page's rows while
   * the new page loads, or `placeholderData` before the first page lands.
   * Dim the table and show a top spinner; flip styles on `false`.
   */
  isPlaceholderData: boolean;
  /**
   * `true` while nothing at all is on screen (no page, no placeholder) —
   * drive the full-page skeleton. Suppressed while `placeholderData` or
   * the previous page is displayed.
   */
  initialLoading: boolean;
  /** `true` on ANY in-flight call — drive the small per-page indicator. */
  loading: boolean;
};

/**
 * Load one page of the project list, keeping the previous page on screen
 * while the next one loads.
 *
 * @param {number} page - 1-based page number; changing it re-runs the query.
 * @return {ProjectPaginatedQueryResult} `{data, isPlaceholderData, initialLoading, loading}`.
 * @example
 * ```tsx
 * function ProjectTable({page}: {page: number}) {
 *   const {data, isPlaceholderData, initialLoading, loading} =
 *     useProjectPaginatedQuery(page);
 *   if (initialLoading) return <ProjectSkeleton />;
 *   return (
 *     <>
 *       {(loading || isPlaceholderData) && <RefreshBar />}
 *       <Table rows={data} dimmed={isPlaceholderData} />
 *     </>
 *   );
 * }
 * ```
 */
export function useProjectPaginatedQuery(
  page: number
): ProjectPaginatedQueryResult;
/**
 * Load one page of a custom size — changing either `page` or `pageSize`
 * re-runs the query (the structural hash covers both).
 *
 * @param {number} page - 1-based page number.
 * @param {number} pageSize - rows per page (default `10`).
 * @param {object} [options] - `placeholderData`: rows shown (with
 *   `isPlaceholderData: true`) until the first page ever lands.
 * @return {ProjectPaginatedQueryResult} `{data, isPlaceholderData, initialLoading, loading}`.
 * @example
 * ```tsx
 * const {data, loading} = useProjectPaginatedQuery(page, 25);
 * ```
 */
export function useProjectPaginatedQuery(
  page: number,
  pageSize: number,
  options?: {placeholderData?: Project}
): ProjectPaginatedQueryResult;
/**
 * Load one page with a first-load placeholder — same as above at the
 * default page size.
 *
 * @param {number} page - 1-based page number.
 * @param {object} options - `placeholderData`: rows shown (with
 *   `isPlaceholderData: true`) until the first page ever lands.
 * @return {ProjectPaginatedQueryResult} `{data, isPlaceholderData, initialLoading, loading}`.
 */
export function useProjectPaginatedQuery(
  page: number,
  options: {placeholderData?: Project}
): ProjectPaginatedQueryResult;
export function useProjectPaginatedQuery(
  page: number,
  pageSizeOrOptions?: number | {placeholderData?: Project},
  maybeOptions?: {placeholderData?: Project}
): ProjectPaginatedQueryResult {
  const options =
    typeof pageSizeOrOptions === 'number' ? maybeOptions : pageSizeOrOptions;
  const pageSize =
    typeof pageSizeOrOptions === 'number' ? pageSizeOrOptions : undefined;
  const loadProjects = useInjectable(fetchProjectPage);
  const query: PageQuery = {page, pageSize: pageSize ?? 10};
  // Structural comparison: the inline object identity changes every render,
  // but only a real page/size change re-runs the query. While it runs, the
  // previous page stays on screen (default keep-previous-data semantics).
  useRun(loadProjects, [query], {hash: stableHash});

  // placeholderData rides useResult's init slot: displayed only until the
  // FIRST result ever arrives — later page changes keep the previous page
  // instead (the store already holds real rows by then).
  const data = useResult(loadProjects, options?.placeholderData);
  const isPlaceholderData = usePlaceholderData(
    loadProjects,
    [query],
    options?.placeholderData
  );
  const initialLoading = useInitialLoading(loadProjects);
  const loading = useLoading(loadProjects);

  return {
    data,
    isPlaceholderData,
    // A placeholderData window is the caller opting out of the skeleton:
    // rows are on screen, so the "nothing to show yet" flag stays false.
    initialLoading: initialLoading && data === undefined,
    loading
  };
}
