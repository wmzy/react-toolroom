import {Func} from '@@/types';
import {RefObject, useCallback, useEffect, useRef} from 'react';

const map = new WeakMap();

// `callContext` is a fresh object created for every single call, so a
// wrapper may stash per-call metadata on it (e.g. the AbortSignal bridge
// registered by `useRun`).
export type InjectWrapper<F extends Func> = (f: F, callContext: any) => F;
type InjectableRef<F extends Func> = [F, InjectWrapper<F>[], any];

/**
 * A registration slot owned by a single `useInject` hook instance.
 * `stable` is the constant wrapper registered in the injectable's wrapper
 * list; `latest` is refreshed on every render so the stable wrapper always
 * forwards to the most recent closure.
 */
type Cell<F extends Func> = {
  stable: InjectWrapper<F>;
  latest: InjectWrapper<F>;
};

/**
 * A higher-order function that takes a function as an argument and returns a new
 * function that can be injected with dependencies. The injected function behaves
 * the same way as the original function but with additional functionality.
 *
 * The wrapper list is stable across renders: wrappers are registered once per
 * `useInject` hook instance (not once per render). This keeps cross-component
 * injection safe — the owning component re-rendering never drops another
 * component's wrapper, and an injecting component re-rendering never
 * duplicates one.
 *
 * @param {Func} fn - The function to be made injectable.
 * @return {Func} - A new function that can be injected with dependencies.
 */
export function useInjectable<F extends Func>(fn: F): F {
  const ref = useRef<InjectableRef<F>>(undefined);
  if (!ref.current) ref.current = [fn, [], {}];
  // Keep the latest fn closure; the wrapper list and context stay stable and
  // are maintained by the individual useInject slots.
  ref.current[0] = fn;

  const f = useCallback((...args: Parameters<F>) => {
    const [func, injects] = ref.current!;
    const callContext = {};
    return injects.reduce((i, w) => w(i, callContext), func)(...args);
  }, []) as F;

  map.set(f, ref);

  return f;
}

export function getInjectContext<F extends Func>(fn: F) {
  const ref = requireInjectableRef(fn, 'getInjectContext');
  return ref.current[2];
}

/** Returns true when fn is a function returned by useInjectable(). */
export function isInjectable<F extends Func>(fn: F): boolean {
  return map.has(fn);
}

/**
 * Registers a wrapper onto an injectable function. Each hook instance owns one
 * registration slot: the wrapper is registered exactly once (re-renders,
 * StrictMode double renders and concurrent discarded renders cannot duplicate
 * it) and is removed from the wrapper list when the injecting component
 * unmounts, so a gone component's wrapper stops firing.
 *
 * @param {F} fn - An injectable function returned by `useInjectable`.
 * @param {InjectWrapper<F>} wrapper - The wrapper to register.
 */
export function useInject<F extends Func>(fn: F, wrapper: InjectWrapper<F>) {
  useInjectCell(fn, 'useInject', wrapper, (list, stable) => list.push(stable));
}

/**
 * Like {@link useInject}, but the wrapper is inserted at the head of the
 * wrapper list, so it is applied before previously registered wrappers and
 * ends up as the innermost layer, closest to the original function.
 *
 * @param {F} fn - An injectable function returned by `useInjectable`.
 * @param {InjectWrapper<F>} wrapper - The wrapper to register.
 */
export function useInjectBefore<F extends Func>(
  fn: F,
  wrapper: InjectWrapper<F>
) {
  useInjectCell(fn, 'useInjectBefore', wrapper, (list, stable) =>
    list.unshift(stable)
  );
}

/**
 * Registers a wrapper onto an injectable function without a hook — the
 * imperative counterpart of {@link useInject}. The wrapper is pushed onto
 * the tail of the wrapper list, so a later registration ends up as an outer
 * layer wrapping everything registered before it. Unlike `useInject` no
 * trampoline is installed: the caller already holds a stable wrapper
 * reference, so keeping it fresh is the caller's job.
 *
 * @param {F} fn - An injectable function returned by `useInjectable`.
 * @param {InjectWrapper<F>} wrapper - The wrapper to register.
 * @return {() => void} A function that removes the wrapper again. Removal
 *   is identity-checked, so it only ever drops its own registration and is
 *   safe to call more than once.
 */
export function addWrapper<F extends Func>(
  fn: F,
  wrapper: InjectWrapper<F>
): () => void {
  const list = requireInjectableRef(fn, 'addWrapper').current[1];
  list.push(wrapper);
  return () => {
    const i = list.indexOf(wrapper);
    if (i !== -1) list.splice(i, 1);
  };
}

function useInjectCell<F extends Func>(
  fn: F,
  hookName: string,
  wrapper: InjectWrapper<F>,
  insert: (list: InjectWrapper<F>[], stable: InjectWrapper<F>) => void
) {
  const ref = requireInjectableRef(fn, hookName);
  const cellRef = useRef<Cell<F>>(undefined);
  if (!cellRef.current) {
    const cell = {latest: wrapper} as Cell<F>;
    // Stable trampoline: registered once, always forwards to the latest
    // wrapper closure.
    cell.stable = (f, ctx) => cell.latest(f, ctx);
    cellRef.current = cell;
    // Register during render so injections are in place before any effect
    // fires (even ones declared earlier). Pushed exactly once per hook
    // instance, so re-renders cannot duplicate the registration.
    insert(ref.current[1], cell.stable);
  } else {
    cellRef.current.latest = wrapper;
  }
  const cell = cellRef.current;
  useEffect(() => {
    const list = ref.current[1];
    // Re-add after StrictMode's simulated unmount/remount; remove on real
    // unmount so the wrapper stops applying once the component is gone.
    if (!list.includes(cell.stable)) insert(list, cell.stable);
    return () => {
      const i = list.indexOf(cell.stable);
      if (i !== -1) list.splice(i, 1);
    };
    // `ref` and `cell` are stable; `insert` is only needed on first run.
  }, [ref, cell]);
}

function requireInjectableRef<F extends Func>(
  fn: F,
  hookName: string
): RefObject<InjectableRef<F>> {
  const ref = map.get(fn) as RefObject<InjectableRef<F>> | undefined;
  if (!ref) {
    throw new Error(
      `${hookName} expects a function returned by useInjectable(), got something else. ` +
        `Get the injectable function from useInjectable() before calling ${hookName}.`
    );
  }
  return ref;
}
