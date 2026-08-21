import {AsyncFunc} from '@@/types';
import {useEffect} from 'react';

/**
 * Calls an injectable function on a fixed interval, optionally with
 * arguments.
 *
 * A tick is skipped while the previous call is still pending, so a slow
 * function never piles up concurrent requests — the semantic equivalent of
 * `refetchInterval` in react-query. While `document.hidden` is `true` the
 * polling is paused unless `whenHidden` is set, and changing `interval`
 * restarts the timer. The timer is cleaned up on unmount.
 *
 * `args` keeps polling on the same keyed entry as `useRun`: `useCache` and
 * `useDedup` hash the call arguments, so polling an injectable that
 * `useRun(fn, [id])` also drives without passing the same `args` would
 * resolve to a different key — a cache miss that spawns a second request
 * line. Arguments are compared element-wise by reference exactly like
 * `useRun`, so an inline literal such as `{args: [id]}` only re-arms the
 * timer when `id` itself changes.
 *
 * @param {AsyncFunc} injectableFn - the wrapped async function to call.
 * @param {number} interval - the delay between ticks in milliseconds.
 * @param {object} [options] - `whenHidden` (default `false`): keep polling
 *   while the document is hidden; `args` (default `[]`): arguments spread
 *   into every tick.
 * @example
 * ```tsx
 * const fetchUserList = useInjectable(fetchList);
 * usePolling(fetchUserList, 10000);
 * ```
 * @example
 * ```tsx
 * const fetchUser = useInjectable((id: string) => api.user(id));
 * useRun(fetchUser, [userId]);
 * // Ticks reuse the cache/dedup key of [userId] instead of opening a
 * // second request line keyed by [].
 * usePolling(fetchUser, 10000, {args: [userId]});
 * ```
 */
export function usePolling<AF extends AsyncFunc>(
  injectableFn: AF,
  interval: number
): void;
export function usePolling<AF extends AsyncFunc>(
  injectableFn: AF,
  interval: number,
  options: {whenHidden?: boolean; args?: Parameters<AF>}
): void;
export function usePolling<AF extends AsyncFunc>(
  injectableFn: AF,
  interval: number,
  options?: {whenHidden?: boolean; args?: Parameters<AF>}
): void {
  const {whenHidden = false, args = []} = options ?? {};
  useEffect(() => {
    let inFlight = false;
    const tick = () => {
      if (!whenHidden && document.hidden) return;
      if (inFlight) return;
      inFlight = true;
      // Both handlers release the slot: a rejected call must not block the
      // next tick forever.
      Promise.resolve(injectableFn(...args)).then(
        () => {
          inFlight = false;
        },
        () => {
          inFlight = false;
        }
      );
    };
    const id = setInterval(tick, interval);
    return () => clearInterval(id);
    // `interval` participates in the dependencies on purpose: a new value
    // tears the old timer down and starts a fresh cadence. `args` is spread
    // element-wise for the same reference comparison `useRun` uses, so the
    // default `[]` adds nothing and never re-arms the timer on re-render.
  }, [injectableFn, interval, whenHidden, ...args]);
}

/**
 * Re-runs an injectable function when the window regains focus or the
 * document becomes visible again — the semantic equivalent of
 * `refetchOnWindowFocus` in react-query.
 *
 * `args` keeps revalidation on the same keyed entry as `useRun`: `useCache`
 * and `useDedup` hash the call arguments, so revalidating an injectable
 * that `useRun(fn, [id])` also drives without passing the same `args` would
 * resolve to a different key — a cache miss that spawns a second request
 * line. Arguments are compared element-wise by reference exactly like
 * `useRun`, so an inline literal such as `{args: [id]}` only re-subscribes
 * when `id` itself changes.
 *
 * @param {AsyncFunc} injectableFn - the wrapped async function to call.
 * @param {object} [options] - `interval` (default `0`): throttle window in
 *   milliseconds; events arriving within the window after a revalidation
 *   are ignored; `args` (default `[]`): arguments spread into every
 *   revalidation.
 * @example
 * ```tsx
 * const fetchUserList = useInjectable(fetchList);
 * useFocusRevalidate(fetchUserList, {interval: 5000});
 * ```
 * @example
 * ```tsx
 * const fetchUser = useInjectable((id: string) => api.user(id));
 * useRun(fetchUser, [userId]);
 * // Focus revalidates the cache/dedup key of [userId], not of [].
 * useFocusRevalidate(fetchUser, {args: [userId]});
 * ```
 */
export function useFocusRevalidate<AF extends AsyncFunc>(
  injectableFn: AF
): void;
export function useFocusRevalidate<AF extends AsyncFunc>(
  injectableFn: AF,
  options: {interval?: number; args?: Parameters<AF>}
): void;
export function useFocusRevalidate<AF extends AsyncFunc>(
  injectableFn: AF,
  options?: {interval?: number; args?: Parameters<AF>}
): void {
  const {interval = 0, args = []} = options ?? {};
  useEffect(() => {
    let last = 0;
    const revalidate = () => {
      const now = Date.now();
      if (now - last < interval) return;
      last = now;
      void injectableFn(...args);
    };
    const onVisibilityChange = () => {
      if (!document.hidden) revalidate();
    };
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // `args` is spread element-wise for the same reference comparison
    // `useRun` uses, so the default `[]` adds nothing and never
    // re-subscribes on re-render.
  }, [injectableFn, interval, ...args]);
}
