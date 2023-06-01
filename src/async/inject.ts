import {Func} from '@@/types';
import {MutableRefObject, useCallback, useRef} from 'react';

const map = new WeakMap();
type Wrapper<F extends Func> = (f: F, callContext: any) => F;

/**
 * A higher-order function that takes a function as an argument and returns a new
 * function that can be injected with dependencies. The injected function behaves
 * the same way as the original function but with additional functionality.
 *
 * @param {Func} fn - The function to be made injectable.
 * @return {Func} - A new function that can be injected with dependencies.
 */
export function useInjectable<F extends Func>(fn: F): F {
  const ref = useRef<[F, Wrapper<F>[], any]>();
  ref.current = [fn, [], {}];

  const f = useCallback((...args: Parameters<F>) => {
    const [func, injects] = ref.current!;
    const callContext = {};
    return injects.reduce((i, w) => w(i, callContext), func)(...args);
  }, []) as F;

  map.set(f, ref);

  return f;
}

export function getInjectContext<F extends Func>(fn: F) {
  const ref = map.get(fn) as MutableRefObject<[F, Wrapper<F>[], any]>;
  return ref.current[2];
}

export function useInject<F extends Func>(fn: F, wrapper: Wrapper<F>) {
  const ref = map.get(fn) as MutableRefObject<[F, Wrapper<F>[]]>;
  ref.current[1].push(wrapper);
}

export function useInjectBefore<F extends Func>(fn: F, wrapper: Wrapper<F>) {
  const ref = map.get(fn) as MutableRefObject<[F, Wrapper<F>[]]>;
  ref.current[1].unshift(wrapper);
}
