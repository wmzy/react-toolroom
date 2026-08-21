/**
 * Project-level query hook template — the base version.
 *
 * This file is a starting point to COPY into your project and customize,
 * not a library export: React Toolroom deliberately ships no preset
 * `useQuery`. The library's position is "tools, not finished products" —
 * composing the atomic hooks is the product, so you are expected to write
 * your project's query hook ONCE (here), then use that hook everywhere.
 * A config-object preset would only re-encode what these hooks already
 * express directly, at the price of an options surface to maintain.
 *
 * Compared with reaching for a per-component composition, this hook keeps
 * every screen on one loading/error contract and gives you exactly one
 * place to change it. Common customization points:
 *
 * - `staleTime` / caching — see `useProjectSWRQuery.ts` for the
 *   `useCache` + `useFocusRevalidate` variant.
 * - Error reporting — `error` below is where a Sentry/toast/report call
 *   belongs; doing it here means components never repeat it.
 * - Cache instance — the SWR variant shows a module-level
 *   `createMemoryCacheProvider` shared by every consumer.
 * - Return shape — add `refetch`, `isStale`, `failureCount`, ... to match
 *   your screens; the fetcher and stores already carry the data for them.
 *
 * The example fetcher comes from the repo's demo services
 * (`demos/services/user.ts`) so the types stay aligned; replace it — and
 * the `Project` alias — with your real API module when copying.
 */

import {
  useDedup,
  useError,
  useInitialLoading,
  useInjectable,
  useResult,
  useRun,
  type R
} from 'react-toolroom/async';
import {fetchList} from '@/services/user';

/** What `fetchList` resolves to — derived, so it cannot drift from the service. */
type Project = R<typeof fetchList>;

/** What `useProjectQuery` hands to your components. */
export type ProjectQueryResult = {
  data: Project | undefined;
  /** `true` only while loading AND no data is on screen (SWR `isLoading`). */
  initialLoading: boolean;
  error: Error | undefined;
};

/**
 * Load the project list once per mount, deduplicated, cancellable.
 *
 * @return {ProjectQueryResult} `{data, initialLoading, error}` — read them
 *   directly in JSX: skeleton while `initialLoading`, message while `error`.
 * @example
 * ```tsx
 * function ProjectList() {
 *   const {data, initialLoading, error} = useProjectQuery();
 *   if (initialLoading) return <ProjectSkeleton />;
 *   if (error) return <p>{error.message}</p>;
 *   return <ul>{data?.map((p) => <li key={p.id}>{p.username}</li>)}</ul>;
 * }
 * ```
 */
export function useProjectQuery(): ProjectQueryResult;
/**
 * Load the project list, optionally sized — changing `size` re-runs the
 * query (and keeps the previous data on screen while the new one loads).
 *
 * @param {object} [options] - `size`: forwarded to the service as its
 *   first argument; omit it to use the service default.
 * @return {ProjectQueryResult} `{data, initialLoading, error}`.
 * @example
 * ```tsx
 * const {data, initialLoading} = useProjectQuery({size: 20});
 * ```
 */
export function useProjectQuery(options: {size?: number}): ProjectQueryResult;
export function useProjectQuery(options?: {size?: number}): ProjectQueryResult {
  // 1. Wrap the fetcher in an injectable: stable identity across renders,
  //    plus the per-instance wrapper chain every hook below registers on.
  const loadProjects = useInjectable(fetchList);

  // 2. Concurrent calls with the same key share one in-flight promise —
  //    covers StrictMode double effects and sibling components mounting
  //    together. The entry is dropped on settle, so failures stay retryable.
  useDedup(loadProjects);

  // 3. Run on mount and whenever `args` change. `signal: true` appends an
  //    AbortSignal as the trailing argument and aborts it on change/unmount,
  //    so the fetch layer can cancel superseded requests. `stableHash` maps
  //    every signal to one placeholder, so signal-appending callers still
  //    deduplicate against each other above.
  useRun(loadProjects, options?.size === undefined ? [] : [options.size], {
    signal: true
  });

  const data = useResult(loadProjects);
  const initialLoading = useInitialLoading(loadProjects);
  const error = useError(loadProjects);

  return {data, initialLoading, error};
}
