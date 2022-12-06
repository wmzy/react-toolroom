import {Func} from '@@/types';
import {MutableRefObject, useCallback, useRef} from 'react';

export function useFn<F extends Func>(fn: F): F {
  const ref = useRef<[F, ((f: F) => F)[]]>();
  ref.current = [fn, []];
  return useCallback((...args: Parameters<F>) => {
    const [func, injects] = ref.current!;
    return injects.reduce((f, w) => w(f), func)(...args);
  }, []) as F;
}

const map = new WeakMap();

export function useInjectable<F extends Func>(fn: F): F {
  const ref = useRef<[F, ((f: F) => F)[]]>();
  ref.current = [fn, []];

  const f = useCallback((...args: Parameters<F>) => {
    const [func, injects] = ref.current!;
    return injects.reduce((i, w) => w(i), func)(...args);
  }, []) as F;

  map.set(f, ref);

  return f;
}

export function useInject<F extends Func>(fn: F, wrapper: (f: F) => F) {
  const ref = map.get(fn) as MutableRefObject<[F, ((f: F) => F)[]]>;
  ref.current[1].push(wrapper);
}

export function useInjectBefore<F extends Func>(fn: F, wrapper: (f: F) => F) {
  const ref = map.get(fn) as MutableRefObject<[F, ((f: F) => F)[]]>;
  ref.current[1].unshift(wrapper);
}
