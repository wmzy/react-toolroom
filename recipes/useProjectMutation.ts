/**
 * Project-level mutation hook template.
 *
 * Since the library grew a first-class `useMutation`, this template is the
 * customization layer on top of it: it pins the project's default failure
 * reporting (an explicit `onError` still replaces it) and re-exports the
 * library contract under project naming. Copy it to see how little a
 * project convention needs — the lifecycle itself (stable `mutate`,
 * shared `isMutating` / `error` / `failureCount`, `reset`, the callback
 * ref funnel) lives in `react-toolroom/async`.
 */

import {
  useMutation,
  type AsyncFunc,
  type MutationOptions,
  type MutationStatus,
  type R
} from 'react-toolroom/async';
import {fetchById} from '@/services/user';

/** What `fetchById` resolves to — derived, so it cannot drift from the service. */
type User = R<typeof fetchById>;

/**
 * Stand-in for a real write endpoint: rename is the smallest mutation that
 * still round-trips through the demo service. Swap it — and the `User`
 * alias — with your real write endpoint when copying; the hook below is
 * generic and does not depend on it.
 */
export async function renameProject(
  id: number,
  username: string
): Promise<User> {
  const current = await fetchById(id);
  return {...current, username};
}

/** Lifecycle callbacks — the library contract, under project naming. */
export type ProjectMutationOptions<M extends AsyncFunc> = MutationOptions<M>;

/** What `useProjectMutation` hands to your components. */
export type ProjectMutationStatus = MutationStatus;

/**
 * Project-default failure reporting for mutations. Wire this to your real
 * reporter (Sentry, toast, …) — components that pass no `onError` get it
 * for free; an explicit `onError` replaces it.
 */
const reportMutationError = (error: Error, ...args: unknown[]) => {
  // eslint-disable-next-line no-console -- demo stand-in reporter.
  console.error('[useProjectMutation]', error, ...args);
};

/**
 * Wrap a mutation with the project defaults: same contract as
 * `useMutation` — `[mutate, status, reset]` — plus default error
 * reporting. See the library hook's docs for the full semantics; the
 * lifecycle tests live in `test/async-hooks.test.ts`.
 *
 * @param {AsyncFunc} mutation - the write function to wrap; inline arrows
 *   are fine.
 * @param {ProjectMutationOptions} [options] - lifecycle callbacks; an
 *   explicit `onError` replaces the project reporter.
 * @return {[M, ProjectMutationStatus, function]} `[mutate, status, reset]`.
 * @example
 * ```tsx
 * const [rename, {isMutating, error}] = useProjectMutation(renameProject, {
 *   onSuccess: () => toast('Saved')
 * });
 * rename(user.id, nextName).catch(() => {});
 * ```
 */
export function useProjectMutation<M extends AsyncFunc>(
  mutation: M,
  options?: ProjectMutationOptions<M>
): [M, ProjectMutationStatus, () => void] {
  // Destructuring default (not a spread): an explicitly passed `onError`
  // — even a per-render inline one — replaces the project reporter,
  // while everything else passes through untouched.
  const {onError = reportMutationError, ...rest} = options ?? {};
  return useMutation(mutation, {...rest, onError});
}
