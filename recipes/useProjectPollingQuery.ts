/**
 * Project-level query hook template — the polling version.
 *
 * Same "copy me and customize" contract as `useProjectQuery.ts`, plus
 * `usePolling`: the ticker is fetched on mount, then re-fetched on a fixed
 * interval. `usePolling` already skips a tick while the previous call is
 * pending (a slow API never piles up concurrent requests) and pauses while
 * the document is hidden, so this template needs nothing extra for either.
 *
 * The example fetcher is the demo ticker (`demos/services/metrics.ts`),
 * whose result increments per call — exactly the shape a polling UI wants.
 *
 * Customization points beyond the base template:
 *
 * - `interval` — the knob this hook exposes; pick it per screen, not per
 *   project.
 * - Stop conditions — polling runs while the component is mounted; gate the
 *   MOUNT (conditionally render the consumer) rather than the hook.
 * - Combine with `useCache`/`useFocusRevalidate` exactly like the SWR
 *   variant when a live dashboard also needs tab-switch freshness.
 */

import {
  useDedup,
  useError,
  useInitialLoading,
  useInjectable,
  usePolling,
  useResult,
  useRun,
  type R
} from 'react-toolroom/async';
import {fetchTicker} from '@/services/metrics';

/** What `fetchTicker` resolves to — `{tick, at}`, derived from the service. */
type Ticker = R<typeof fetchTicker>;

/** What `useProjectPollingQuery` hands to your components. */
export type ProjectPollingQueryResult = {
  data: Ticker | undefined;
  /** `true` only until the first result lands; later ticks update in place. */
  initialLoading: boolean;
  error: Error | undefined;
};

/**
 * Load the ticker once, then poll it on a default 3 s interval.
 *
 * @return {ProjectPollingQueryResult} `{data, initialLoading, error}` — the
 *   result store is never reset between ticks, so `data` always holds the
 *   latest settled value.
 * @example
 * ```tsx
 * function TickerWidget() {
 *   const {data, initialLoading, error} = useProjectPollingQuery();
 *   if (initialLoading) return <Skeleton />;
 *   if (error) return <p>{error.message}</p>;
 *   return <span>tick #{data?.tick}</span>;
 * }
 * ```
 */
export function useProjectPollingQuery(): ProjectPollingQueryResult;
/**
 * Load the ticker once, then poll it on a custom interval — ticks while the
 * previous call is pending are skipped, and the timer restarts when
 * `interval` itself changes.
 *
 * @param {number} interval - delay between ticks in milliseconds.
 * @return {ProjectPollingQueryResult} `{data, initialLoading, error}`.
 * @example
 * ```tsx
 * const {data} = useProjectPollingQuery(1000); // every second
 * ```
 */
export function useProjectPollingQuery(
  interval: number
): ProjectPollingQueryResult;
export function useProjectPollingQuery(
  interval?: number
): ProjectPollingQueryResult {
  const loadTicker = useInjectable(fetchTicker);
  // Both `useRun` and `usePolling` call with `[]`, so they address the same
  // dedup key — a rerun racing a tick shares one request instead of two.
  useDedup(loadTicker);
  useRun(loadTicker, []);
  usePolling(loadTicker, interval ?? 3000);

  const data = useResult(loadTicker);
  const initialLoading = useInitialLoading(loadTicker);
  const error = useError(loadTicker);

  return {data, initialLoading, error};
}
