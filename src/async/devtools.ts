import {AsyncFunc, R} from '@@/types';
import {addWrapper} from './inject';

/**
 * Subscribes to every call of an injectable function — the zero-dependency
 * observability primitive of the injection system, meant for devtools and
 * logging panels. `onCall` fires with the arguments before the chain runs;
 * `onSettle` fires exactly once when the call settles, on success or
 * failure.
 *
 * The observer is registered as the outermost wrapper available at
 * subscription time, so `duration` measures the whole onion chain it sees:
 * the original function plus every wrapper registered before the
 * subscription. A minimal call-trace panel needs nothing else:
 *
 * ```js
 * subscribeInjectEvents(fetchUser, {
 *   onCall: (args) => console.log('→ fetchUser', ...args),
 *   onSettle: ({args, result, error, duration}) =>
 *     console.log('← fetchUser', {args, result, error, duration})
 * });
 * ```
 *
 * @param {AF} fn - An injectable function returned by `useInjectable`.
 * @param {object} handlers - `onCall`/`onSettle` callbacks; both optional.
 * @return {() => void} A function that unsubscribes the observer.
 */
export function subscribeInjectEvents<AF extends AsyncFunc>(
  fn: AF,
  handlers: {
    onCall?: (args: Parameters<AF>) => void;
    onSettle?: (info: {
      args: Parameters<AF>;
      result?: R<AF>;
      error?: any;
      duration: number;
    }) => void;
  }
): () => void {
  return addWrapper(
    fn,
    (next) =>
      ((...args: Parameters<AF>) => {
        const start = performance.now();
        handlers.onCall?.(args);
        return next(...args).then(
          (result) => {
            handlers.onSettle?.({
              args,
              result,
              duration: performance.now() - start
            });
            return result;
          },
          (error) => {
            handlers.onSettle?.({
              args,
              error,
              duration: performance.now() - start
            });
            throw error;
          }
        );
      }) as AF
  );
}
