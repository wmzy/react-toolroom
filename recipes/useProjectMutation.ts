/**
 * Project-level mutation hook template.
 *
 * Same "copy me and customize" contract as `useProjectQuery.ts`, but for
 * writes. The library ships no `useMutation` on purpose: a mutation is just
 * an injectable you call yourself (from an event handler, not `useRun`),
 * and everything worth having — lifecycle flags, error, retry counts — is
 * already carried by the shared stores the atomic hooks subscribe to. This
 * template wires those together once so every screen gets the same
 * mutation contract, and adds the one thing the primitives do not have:
 * `onMutate`/`onSuccess`/`onError`/`onSettled` callbacks.
 *
 * Division of labor with the other mutation tools:
 *
 * - THIS template owns the mutation lifecycle — call flags, error surface,
 *   and success/failure side effects (toasts, navigation, logging).
 * - `useOptimistic(fn, updater)` owns optimistic UI — publish a predicted
 *   snapshot at call time, roll back on failure. Compose it ON the same
 *   injectable inside your component when the edit is locally predictable.
 * - `useInvalidate(fetchFn, cache)` owns hard revalidation of the queries
 *   a mutation dirties — call it from `onSuccess` when it is not.
 *
 * Customization points:
 *
 * - Error reporting — `error` below is where a Sentry/toast/report call
 *   belongs (or in `onError`, which also sees the call args).
 * - Return shape — add `data` (`useResult`), `reset`, a `mutate` wrapper
 *   that swallows rejections TanStack-style, ... to match your screens.
 * - Rejections always propagate out of `mutate` — the injectable behaves
 *   like the original function. Fire-and-forget callers that read `error`
 *   instead of awaiting should append `.catch(() => {})`.
 *
 * The example mutation is a stand-in over the demo services
 * (`demos/services/user.ts`); replace it — and the `User` alias — with
 * your real write endpoint when copying.
 */

import {useRef} from 'react';
import {
  useError,
  useFailureCount,
  useInject,
  useInjectable,
  useLoading,
  type AsyncFunc,
  type R
} from 'react-toolroom/async';
import {fetchById} from '@/services/user';

/** What `fetchById` resolves to — derived, so it cannot drift from the service. */
type User = R<typeof fetchById>;

/**
 * Stand-in for a real write endpoint: rename is the smallest mutation that
 * still round-trips through the demo service. Swap for your API when
 * copying — the hook below is generic and does not depend on it.
 */
export async function renameProject(
  id: number,
  username: string
): Promise<User> {
  const current = await fetchById(id);
  return {...current, username};
}

/** Lifecycle callbacks of one mutation — naming aligned with TanStack/SWR. */
export type ProjectMutationOptions<M extends AsyncFunc> = {
  /** Fires synchronously right before the call starts. */
  onMutate?: (...args: Parameters<M>) => void;
  /** Fires with the resolved value when the call succeeds. */
  onSuccess?: (result: R<M>, ...args: Parameters<M>) => void;
  /** Fires with the rejection when the call fails. */
  onError?: (error: Error, ...args: Parameters<M>) => void;
  /** Fires exactly once per call, after `onSuccess` or `onError`. */
  onSettled?: (
    result: R<M> | undefined,
    error: Error | undefined,
    ...args: Parameters<M>
  ) => void;
};

/** What `useProjectMutation` hands to your components. */
export type ProjectMutationStatus = {
  /** `true` while any call is in flight (concurrent calls all count). */
  isMutating: boolean;
  /** The latest error; a later success clears it. Shared per injectable. */
  error: Error | undefined;
  /** Consecutive failures so far; a success resets it to `0`. */
  failureCount: number;
};

/**
 * Wrap a mutation: get back the same function (stable identity, now
 * tracked) plus its lifecycle state.
 *
 * @param {AsyncFunc} mutation - the write function to wrap; inline arrows
 *   are fine — `useInjectable` adopts the latest closure every render.
 * @return {[M, ProjectMutationStatus]} `[mutate, status]` — call `mutate`
 *   from event handlers; render `isMutating` on the submit button and
 *   `error`/`failureCount` for feedback UI.
 * @example
 * ```tsx
 * function RenameForm({user, nextName}: {user: User; nextName: string}) {
 *   const [rename, {isMutating, error}] = useProjectMutation(renameProject, {
 *     onSuccess: () => toast('Saved')
 *   });
 *   return (
 *     <form onSubmit={(e) => {
 *       e.preventDefault();
 *       rename(user.id, nextName).catch(() => {});
 *     }}>
 *       {error && <p>{error.message}</p>}
 *       <button disabled={isMutating}>Save</button>
 *     </form>
 *   );
 * }
 * ```
 */
export function useProjectMutation<M extends AsyncFunc>(
  mutation: M
): [M, ProjectMutationStatus];
/**
 * Wrap a mutation with lifecycle callbacks — `options` may be a fresh
 * object every render; the callbacks fire with the latest closure.
 *
 * @param {AsyncFunc} mutation - the write function to wrap.
 * @param {ProjectMutationOptions<M>} options - `onMutate`/`onSuccess`/
 *   `onError`/`onSettled` callbacks; all optional.
 * @return {[M, ProjectMutationStatus]} `[mutate, status]`.
 * @example
 * ```tsx
 * const [save, {isMutating}] = useProjectMutation(renameProject, {
 *   onSettled: () => setLoading(false)
 * });
 * ```
 */
export function useProjectMutation<M extends AsyncFunc>(
  mutation: M,
  options: ProjectMutationOptions<M>
): [M, ProjectMutationStatus];
export function useProjectMutation<M extends AsyncFunc>(
  mutation: M,
  options?: ProjectMutationOptions<M>
): [M, ProjectMutationStatus] {
  // 1. The injectable IS the returned `mutate`: stable identity across
  //    renders, and the per-instance wrapper chain the hooks below (and
  //    useOptimistic/useInvalidate in consumers) register on.
  const mutate = useInjectable(mutation);

  // 2. Ref funnel for the callbacks: `options` is usually an inline object
  //    (new identity every render). One wrapper is registered ONCE on the
  //    chain and reads through the ref, so callbacks stay fresh without
  //    re-registering the wrapper or dragging options through effect deps.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useInject(
    mutate,
    (f: M) =>
      ((...args: Parameters<M>) => {
        const {onMutate, onSuccess, onError, onSettled} =
          optionsRef.current ?? {};
        onMutate?.(...args);
        return f(...args).then(
          (result) => {
            onSuccess?.(result, ...args);
            onSettled?.(result, undefined, ...args);
            return result;
          },
          (e: any) => {
            onError?.(e, ...args);
            onSettled?.(undefined, e, ...args);
            // Rejections keep flowing: `mutate` behaves like the original
            // function, so awaiting callers can branch on the outcome.
            throw e;
          }
        );
      }) as M
  );

  // 3. Subscribe to the shared stores — every flag is injectable-level
  //    state, so sibling components tracking the same mutation update
  //    together and late mounters start from the current values.
  const isMutating = useLoading(mutate);
  const error = useError(mutate);
  const failureCount = useFailureCount(mutate);

  return [mutate, {isMutating, error, failureCount}];
}
