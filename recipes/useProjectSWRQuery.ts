/**
 * Project-level query hook template — the SWR (stale-while-revalidate) version.
 *
 * Same "copy me and customize" contract as `useProjectQuery.ts`, plus two
 * capabilities layered on the identical hook stack:
 *
 * - `useCache(load, projectCache, staleTime)` — a module-level memory cache:
 *   remounting components render cached data immediately; entries older
 *   than `staleTime` revalidate in the background (failures swallowed, so
 *   stale data stays on screen).
 * - `useFocusRevalidate(load)` — refetch when the window regains focus.
 *
 * The cache provider lives at module scope because it must outlive any
 * component: `createMemoryCacheProvider` is a plain function, so every
 * component importing this hook shares one instance — that shared instance
 * IS the cross-component cache, no Provider required.
 *
 * One key-alignment footgun baked into the design: cache keys are hashed
 * from the raw call args, so `useRun` here passes `[]` WITHOUT
 * `{signal: true}` — an appended `AbortSignal` would change the args tuple
 * and split the cache line from `useFocusRevalidate`'s `[]` revalidations.
 * (Keep the signal variant in the base template, where no cache keys it.)
 */

import {
  createMemoryCacheProvider,
  useCache,
  useDedup,
  useError,
  useFocusRevalidate,
  useInitialLoading,
  useInjectable,
  useResult,
  useRun,
  type R
} from 'react-toolroom/async';
import {fetchList} from '@/services/user';

type Project = R<typeof fetchList>;

// Module scope: one cache shared by every component importing this hook.
// Customization point — swap the provider (e.g. a localStorage-backed one)
// or tune `cacheTime` (idle entries are garbage-collected after it).
const projectCache = createMemoryCacheProvider<Project, any[]>({
  cacheTime: 60000
});

/** What `useProjectSWRQuery` hands to your components. */
export type ProjectSWRQueryResult = {
  data: Project | undefined;
  /** `true` only while the FIRST load is in flight; cache hits skip it. */
  initialLoading: boolean;
  error: Error | undefined;
  /** `true` while the on-screen data is older than `staleTime`. */
  isStale: boolean;
};

/**
 * Load the project list through a shared stale-while-revalidate cache.
 *
 * @return {ProjectSWRQueryResult} `{data, initialLoading, error, isStale}` —
 *   a fresh `staleTime` default of 5 s keeps focus refetches cheap; render
 *   `isStale` as a subtle "updating…" hint if your UI wants one.
 * @example
 * ```tsx
 * function ProjectList() {
 *   const {data, initialLoading, isStale} = useProjectSWRQuery();
 *   if (initialLoading) return <ProjectSkeleton />;
 *   return <ProjectTable projects={data} updating={isStale} />;
 * }
 * ```
 */
export function useProjectSWRQuery(): ProjectSWRQueryResult;
/**
 * Load the project list through the shared cache with a custom freshness
 * window — `0` revalidates on every hit, larger values serve stale data
 * longer before background-refreshing.
 *
 * @param {object} options - `staleTime`: milliseconds a cached entry stays
 *   fresh (default `5000`).
 * @return {ProjectSWRQueryResult} `{data, initialLoading, error, isStale}`.
 * @example
 * ```tsx
 * const {data} = useProjectSWRQuery({staleTime: 0}); // always revalidate
 * ```
 */
export function useProjectSWRQuery(options: {
  staleTime?: number;
}): ProjectSWRQueryResult;
export function useProjectSWRQuery(options?: {
  staleTime?: number;
}): ProjectSWRQueryResult {
  const staleTime = options?.staleTime ?? 5000;

  const loadProjects = useInjectable(fetchList);
  // Order does not matter (each hook registers one wrapper), but note the
  // cache wraps around the deduped call: background revalidations triggered
  // by cache hits and focus events collapse into one request.
  useDedup(loadProjects);
  const isStale = useCache(loadProjects, projectCache, staleTime);
  useFocusRevalidate(loadProjects);
  // Plain `[]` — see the header note on cache-key alignment with
  // `useFocusRevalidate` before adding options or `{signal: true}`.
  useRun(loadProjects, []);

  const data = useResult(loadProjects);
  const initialLoading = useInitialLoading(loadProjects);
  const error = useError(loadProjects);

  return {data, initialLoading, error, isStale};
}
