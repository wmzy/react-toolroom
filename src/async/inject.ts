import {Func} from '@@/types';
import {
  RefObject,
  useCallback,
  useEffect,
  useInsertionEffect,
  useRef
} from 'react';

const map = new WeakMap();

// --- Named injectables: the devtools discovery channel ---
//
// An injectable's wrapper list lives on its hook instance: wrappers —
// devtools observers included — registered on one instance never see
// calls through another instance, and two components using the same
// preset each own a separate `useInjectable`. That is correct for
// behavior (each component composes its own chain) but leaves tooling
// blind: a panel cannot observe a preset's internal injectable without a
// reference being handed to it. This module-level registry closes that
// gap and nothing else: it lists the live named instances while every
// per-instance store (wrapper list, call context) stays where it was.
//
// `useInjectable(fn, {name})` publishes its instance for the lifetime of
// its component. Duplicate names coexist — each instance registers and
// unregisters exactly itself, so a panel observes calls through every
// live instance sharing a name. Registration happens in an effect,
// never during render: a discarded render pass would leave an orphan
// instance no cleanup ever removes (the trampoline machinery below
// fights the same class of leaks for render-time wrappers).
const namedInjectables = new Set<Func>();
const namedSubscribers = new Set<() => void>();

const notifyNamedSubscribers = () => {
  namedSubscribers.forEach((listener) => listener());
};

/** Every currently mounted `useInjectable(fn, {name})` instance. */
export function getNamedInjectables(): readonly Func[] {
  return [...namedInjectables];
}

/**
 * Subscribes to named-registry membership changes: the listener fires
 * after every registration and unregistration and carries no payload —
 * poll {@link getNamedInjectables} for the current members.
 *
 * Not re-exported from the package entries: the devtools entry is the
 * consumer; panels reach the registry through `<InjectDevTools>` (omit
 * `injectables` or pass `registry`).
 */
export function subscribeNamedInjectables(listener: () => void): () => void {
  namedSubscribers.add(listener);
  return () => {
    namedSubscribers.delete(listener);
  };
}

// Trampoline bookkeeping for React 18's discarded render passes (StrictMode
// replays each mount render twice and throws the first hook state away, so
// the first pass registers a trampoline no cleanup will ever remove; React
// 19 reuses hook state across the replay, and concurrent rendering can
// discard whole passes the same way). See useInjectable for how the orphans
// are told apart from not-yet-confirmed siblings of the same commit.
const CLAIMED = Symbol('claimed');
const SEQ = Symbol('seq');

type Registry = {
  /** Monotonic insertion counter for render-time trampolines. */
  next: number;
  /**
   * Largest SEQ among trampolines confirmed by an effect. An unconfirmed
   * trampoline with a smaller SEQ predates a confirmed insertion, so it can
   * only come from a discarded render pass: SEQ grows monotonically with
   * each render-time insertion, so a not-yet-confirmed sibling of the same
   * commit always carries a larger SEQ than every confirmed trampoline.
   */
  claimMax: number;
};

// `callContext` is a fresh object created for every single call, so a
// wrapper may stash per-call metadata on it (e.g. the AbortSignal bridge
// registered by `useRun`).
export type InjectWrapper<F extends Func> = (f: F, callContext: any) => F;
type InjectableRef<F extends Func> = [F, InjectWrapper<F>[], any, Registry];

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

// Confirming a trampoline must happen before any effect may call the
// injectable, so prefer useInsertionEffect (which fires before layout and
// passive effects); React 16.8/17 lack it and fall back to useEffect —
// they have no StrictMode replay, so the fallback is safe there.
const useClaim: typeof useEffect =
  typeof useInsertionEffect === 'function' ? useInsertionEffect : useEffect;

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
 * `options.name` opts into the named registry, the discovery channel of
 * `react-toolroom/devtools`: the instance is published for the lifetime of
 * its component, so `<InjectDevTools>` (without an `injectables` prop)
 * observes its calls — the way to watch injectables created inside preset
 * hooks (`useQuery`-like compositions), whose references never leave the
 * preset. The name also becomes the injectable's display name (`fn.name`),
 * so log rows and stack traces read it instead of `'anonymous'`. Without a
 * name nothing is registered and the code path is identical to before.
 *
 * @param {F} fn - The function to be made injectable.
 * @param {object} [options] - `{name}`: register into the named registry for
 *   devtools observation. Static per call site — the first render's value
 *   is fixed; toggling it later would reorder this component's hooks.
 * @return {F} - A new function that can be injected with dependencies.
 */
export function useInjectable<F extends Func>(
  fn: F,
  options?: {name?: string}
): F {
  const ref = useRef<InjectableRef<F>>(undefined);
  if (!ref.current) ref.current = [fn, [], {}, {next: 0, claimMax: -1}];
  // Keep the latest fn closure; the wrapper list and context stay stable and
  // are maintained by the individual useInject slots.
  ref.current[0] = fn;

  const f = useCallback((...args: Parameters<F>) => {
    const [func, injects, , registry] = ref.current!;
    // Drop orphans left by discarded render passes. A trampoline that no
    // effect ever claimed and that predates the latest confirmed insertion
    // belongs to a hook state React threw away — its cleanup will never
    // run. Siblings of the same commit carry a larger SEQ than every
    // confirmed trampoline, so they are safe here. Until the first claim
    // this filter keeps everything, which preserves the render-time
    // registration contract for early callers.
    for (let i = injects.length - 1; i >= 0; i--) {
      const stable = injects[i] as any;
      if (
        stable[SEQ] !== undefined &&
        !stable[CLAIMED] &&
        stable[SEQ] < registry.claimMax
      ) {
        injects.splice(i, 1);
      }
    }
    const callContext = {};
    return injects.reduce((i, w) => w(i, callContext), func)(...args);
  }, []) as F;

  map.set(f, ref);

  // Named registration (see the registry above). The decision and the name
  // are captured on the first render — an option that appears or vanishes
  // later would reorder this component's hooks. The unnamed path pays one
  // useRef read: no state, no effect, no registration.
  const name = useRef(options?.name).current;
  if (name !== undefined) {
    useClaim(() => {
      // The registered name doubles as the display name — set once per
      // mount, inside the effect (never during render).
      Object.defineProperty(f, 'name', {value: name});
      namedInjectables.add(f);
      notifyNamedSubscribers();
      // Re-add after StrictMode's simulated unmount; remove on real
      // unmount so the registry entry dies with its component.
      return () => {
        namedInjectables.delete(f);
        notifyNamedSubscribers();
      };
    });
  }

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
    // instance, so re-renders cannot duplicate the registration. The SEQ
    // lets useInjectable tell this insertion apart from orphans left by
    // discarded render passes (see the claim in the effect below).
    (cell.stable as any)[SEQ] = ref.current[3].next++;
    insert(ref.current[1], cell.stable);
  } else {
    cellRef.current.latest = wrapper;
  }
  const cell = cellRef.current;
  useClaim(() => {
    const list = ref.current[1];
    const registry = ref.current[3];
    // Confirming this trampoline means its component committed: every
    // earlier unconfirmed trampoline is an orphan from a discarded pass.
    const seq = (cell.stable as any)[SEQ] as number;
    (cell.stable as any)[CLAIMED] = true;
    // claimMax starts at -1 ("nothing claimed yet"); the first claim seeds
    // it, later ones can only push it up.
    registry.claimMax = Math.max(registry.claimMax, seq);
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
