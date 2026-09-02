import {AsyncFunc} from '@@/types';
import {useEffect, useRef} from 'react';
import {stableHash} from '@@/util';
import {
  emitError,
  emitKeyedError,
  errorEmissionClaimed,
  getErrorStore,
  getKeyedStore,
  nextErrorSeq,
  nextKeyedErrorSeq,
  trimTrailingSignal
} from './base';
import {isInjectable, useInject} from './inject';

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
 * Every tick's settle outcome is recorded on the injectable's error
 * channels — the shared broadcast `useError` reads and the keyed slot
 * `useArgsStatus(fn, args)` reads — even when no error channel is mounted
 * at tick time: a failed tick published while nobody watches stays
 * readable for a channel mounting later, and the next successful tick
 * clears it (the same clear-on-success semantics a mounted `useError`
 * wrapper gives its own calls). A call whose emission a live
 * useError-family wrapper already serves is left entirely to it, so one
 * failed tick tallies `failureCount` exactly once.
 *
 * `args` keeps polling on the same keyed entry as `useRun`: `useCache`
 * hashes the call arguments, so polling an injectable that
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
 * // Ticks reuse the cache key of [userId] instead of opening a
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
  // Tick marker: the error-recording wrapper below must observe ONLY the
  // calls this instance's own timer issued — every other call through the
  // shared chain (a `useRun` rerun, a manual call, a focus revalidation)
  // passes through untouched, exactly as before this hook grew an error
  // channel. The marker is set around the synchronous call fold, so a
  // wrapper of ANOTHER usePolling instance on the same injectable never
  // mistakes this tick for its own.
  const tickingRef = useRef(false);
  if (isInjectable(injectableFn)) {
    useInject(
      injectableFn,
      (f: AF, callContext: any) =>
        ((...callArgs: Parameters<AF>) => {
          if (!tickingRef.current) return f(...callArgs);
          const key = stableHash(trimTrailingSignal(callArgs));
          // The fold below runs synchronously — every useError-family
          // wrapper this call passes through claims the settle emission
          // before this line resumes, so the claim check afterwards sees
          // the chain's final composition for THIS call (never a wrapper
          // that mounted later, never one that already left).
          const p = Promise.resolve(f(...callArgs));
          if (errorEmissionClaimed(callContext)) return p;
          // Unclaimed: this tick's outcome would otherwise be invisible
          // (nothing in the chain records it), so the poller records it
          // itself — reservations happen after the fold, still inside the
          // call's synchronous extent, so ticket order stays call order.
          // The rejection is rethrown for outer layers (useCatch, the
          // boundary's swallow) exactly like useErrorWrapper rethrows.
          const errorStore = getErrorStore(injectableFn);
          const keyedStore = getKeyedStore(injectableFn);
          const seq = nextErrorSeq(errorStore);
          const keyedSeq = nextKeyedErrorSeq(keyedStore, key);
          return p.then(
            (result) => {
              emitError(errorStore, undefined, seq);
              emitKeyedError(keyedStore, key, undefined, keyedSeq);
              return result;
            },
            (e) => {
              emitError(errorStore, e, seq);
              emitKeyedError(keyedStore, key, e, keyedSeq);
              throw e;
            }
          );
        }) as AF
    );
  }
  useEffect(() => {
    let inFlight = false;
    const tick = () => {
      if (!whenHidden && document.hidden) return;
      if (inFlight) return;
      inFlight = true;
      tickingRef.current = true;
      let call: Promise<unknown>;
      try {
        call = Promise.resolve(injectableFn(...args));
      } finally {
        tickingRef.current = false;
      }
      // Both handlers release the slot: a rejected call must not block the
      // next tick forever. The settle outcome itself is recorded on the
      // error channels by the wrapper above (or by a useError-family
      // wrapper that claimed the emission), so this handler only tends to
      // the cadence.
      call.then(
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
 * hashes the call arguments, so revalidating an injectable
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
 * // Focus revalidates the cache key of [userId], not of [].
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

/**
 * Re-runs an injectable function when the network connection comes back —
 * the semantic equivalent of `revalidateOnReconnect` in SWR and
 * `refetchOnReconnect` in react-query. Complements `useFocusRevalidate`:
 * one covers the user coming back to the tab, the other the browser coming
 * back online.
 *
 * `args` keeps revalidation on the same keyed entry as `useRun`: `useCache`
 * hashes the call arguments, so revalidating an injectable
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
 * useReconnectRevalidate(fetchUserList, {interval: 5000});
 * ```
 * @example
 * ```tsx
 * const fetchUser = useInjectable((id: string) => api.user(id));
 * useRun(fetchUser, [userId]);
 * // Reconnect revalidates the cache key of [userId], not of [].
 * useReconnectRevalidate(fetchUser, {args: [userId]});
 * ```
 */
export function useReconnectRevalidate<AF extends AsyncFunc>(
  injectableFn: AF
): void;
export function useReconnectRevalidate<AF extends AsyncFunc>(
  injectableFn: AF,
  options: {interval?: number; args?: Parameters<AF>}
): void;
export function useReconnectRevalidate<AF extends AsyncFunc>(
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
    const onOnline = () => {
      // Best-effort: the event semantics already guarantee connectivity,
      // but a stale or mocked navigator must not trigger a doomed request.
      if (navigator.onLine) revalidate();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
    // `args` is spread element-wise for the same reference comparison
    // `useRun` uses, so the default `[]` adds nothing and never
    // re-subscribes on re-render.
  }, [injectableFn, interval, ...args]);
}
