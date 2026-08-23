import {AsyncFunc, R} from '@@/types';
import {currentResultSeq, emitResult, getResultStore} from './base';
import {useInject} from './inject';

/**
 * Optimistic updates for an injectable async function: every call first
 * publishes a snapshot derived from the current result, then lets the real
 * call run. On success the real result simply overwrites the snapshot
 * through the normal result broadcast; on failure the store is rolled back
 * to the pre-call value and the rejection keeps traveling up the chain, so
 * `useError` / `useCatch` / `useFailureCount` still observe it.
 *
 * Division of labor with `useInvalidate`: this hook is **optimistic UI** —
 * the same injectable's result store is patched instantly and reconciled
 * by the call's own outcome, so no second request is ever issued.
 * `useInvalidate` is a **hard invalidation** — after a mutation it drops a
 * cached query entry and refetches it, trading a fresh loading cycle for
 * guaranteed server truth. Use `useOptimistic` for snappy local edits
 * whose effect you can predict (toggles, renames, appends) and
 * `useInvalidate` when the mutation invalidates data you cannot compute
 * locally (a search filter that changes a list rendered elsewhere).
 *
 * The updater receives the current result (`draft`) plus the call
 * arguments and returns the next snapshot. Return a NEW value (immutable
 * style): returning nothing keeps the previous value, so an updater that
 * only mutates `draft` in place cannot trigger the re-render — and would
 * also leave nothing to roll back to.
 *
 * @param {AF} injectableFn - the injectable async function whose calls get
 *   optimistic snapshots.
 * @param {(draft: R<AF>, ...args: Parameters<AF>) => R<AF> | void} updater -
 *   computes the optimistic snapshot from the current result and the call
 *   arguments.
 * @return {void} Nothing is returned; the hook only registers the wrapper.
 * @example
 * ```tsx
 * const saveName = useInjectable((name: string) => api.rename(id, name));
 * useOptimistic(saveName, (draft, name) => `saving: ${name}`);
 * const name = useResult(saveName);
 * const error = useError(saveName);
 *
 * // Click → "saving: alice" renders immediately; the store shows the
 * // server truth once the call resolves, or the pre-call value again
 * // when it rejects (the error still reaches useError).
 * <button type='button' onClick={() => saveName('alice')}>Rename</button>
 * ```
 */
export function useOptimistic<AF extends AsyncFunc>(
  injectableFn: AF,
  updater: (draft: R<AF>, ...args: Parameters<AF>) => R<AF> | void
): void {
  const store = getResultStore(injectableFn);
  useInject(
    injectableFn,
    (f: AF) =>
      ((...args: Parameters<AF>) => {
        const before = store.hasResult ? store.lastResult : undefined;
        const next = updater(before, ...args);
        const optimistic = next === undefined ? before : next;
        // Emit with the CURRENT seq (the latest applied ticket), never a
        // fresh nextResultSeq() one: a fresh ticket would raise the
        // watermark above the ticket the outer useResult wrapper reserved
        // for this very call, and the real result would then be dropped by
        // the "an older result must not overwrite a newer one" rule.
        if (optimistic !== undefined) {
          emitResult(store, optimistic, currentResultSeq(store));
        }
        return f(...args).then(undefined, (e: any) => {
          // Roll back — but only while our snapshot is still on display:
          // a newer call's result must never be clobbered by this call's
          // rollback. The rejection is rethrown so the rest of the chain
          // (useError, useCatch, …) still sees it.
          if (store.lastResult === optimistic && before !== optimistic) {
            emitResult(store, before, currentResultSeq(store));
          }
          throw e;
        });
      }) as AF
  );
}
