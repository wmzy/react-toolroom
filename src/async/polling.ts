import {AsyncFunc} from '@@/types';
import {useEffect} from 'react';

/**
 * Calls an injectable function on a fixed interval, without arguments.
 *
 * A tick is skipped while the previous call is still pending, so a slow
 * function never piles up concurrent requests — the semantic equivalent of
 * `refetchInterval` in react-query. While `document.hidden` is `true` the
 * polling is paused unless `whenHidden` is set, and changing `interval`
 * restarts the timer. The timer is cleaned up on unmount.
 *
 * @param {AsyncFunc} injectableFn - the wrapped async function to call.
 * @param {number} interval - the delay between ticks in milliseconds.
 * @param {object} [options] - `whenHidden` (default `false`): keep polling
 *   while the document is hidden.
 * @example
 * ```tsx
 * const fetchUserList = useInjectable(fetchList);
 * usePolling(fetchUserList, 10000);
 * ```
 */
export function usePolling<AF extends AsyncFunc>(
  injectableFn: AF,
  interval: number
): void;
export function usePolling<AF extends AsyncFunc>(
  injectableFn: AF,
  interval: number,
  options: {whenHidden?: boolean}
): void;
export function usePolling<AF extends AsyncFunc>(
  injectableFn: AF,
  interval: number,
  options?: {whenHidden?: boolean}
): void {
  const {whenHidden = false} = options ?? {};
  useEffect(() => {
    let inFlight = false;
    const tick = () => {
      if (!whenHidden && document.hidden) return;
      if (inFlight) return;
      inFlight = true;
      // Both handlers release the slot: a rejected call must not block the
      // next tick forever.
      Promise.resolve(injectableFn()).then(
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
    // tears the old timer down and starts a fresh cadence.
  }, [injectableFn, interval, whenHidden]);
}

/**
 * Re-runs an injectable function when the window regains focus or the
 * document becomes visible again — the semantic equivalent of
 * `refetchOnWindowFocus` in react-query.
 *
 * @param {AsyncFunc} injectableFn - the wrapped async function to call.
 * @param {object} [options] - `interval` (default `0`): throttle window in
 *   milliseconds; events arriving within the window after a revalidation
 *   are ignored.
 * @example
 * ```tsx
 * const fetchUserList = useInjectable(fetchList);
 * useFocusRevalidate(fetchUserList, {interval: 5000});
 * ```
 */
export function useFocusRevalidate<AF extends AsyncFunc>(
  injectableFn: AF
): void;
export function useFocusRevalidate<AF extends AsyncFunc>(
  injectableFn: AF,
  options: {interval?: number}
): void;
export function useFocusRevalidate<AF extends AsyncFunc>(
  injectableFn: AF,
  options?: {interval?: number}
): void {
  const {interval = 0} = options ?? {};
  useEffect(() => {
    let last = 0;
    const revalidate = () => {
      const now = Date.now();
      if (now - last < interval) return;
      last = now;
      void injectableFn();
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
  }, [injectableFn, interval]);
}
