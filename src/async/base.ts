import {AsyncFunc, Func, R} from '@@/types';
import {thru} from '@@/util';
import {useEffect, useState} from 'react';

export function useLoading() {
  const [count, setCount] = useState(0);
  const withLoading = <P extends Promise<any>>(p: P) => (
    setCount((c) => c + 1), p.finally(() => setCount((c) => c - 1))
  );
  return [Boolean(count), withLoading] as const;
}

export function useLoadingFn() {
  const [loading, withLoading] = useLoading();
  const wrap = <AF extends AsyncFunc>(fn: AF) =>
    ((...args: Parameters<AF>) => withLoading(fn(...args))) as AF;
  return [loading, wrap] as const;
}

export function useResult<AF extends AsyncFunc>(
  fn: AF
): [R<AF> | undefined, AF];
export function useResult<AF extends AsyncFunc>(
  fn: AF,
  init: R<AF>
): [R<AF>, AF];
export function useResult<AF extends AsyncFunc>(
  fn: AF,
  init?: R<AF>
): [R<AF> | undefined, AF] {
  type RAF = R<AF>;
  const [result, setResult] = useState<RAF | undefined>(init);
  const wrapped = ((...args: Parameters<AF>) =>
    fn(...args).then(thru<RAF>((r) => setResult(() => r)))) as AF;
  return [result, wrapped];
}

export function useRun<F extends Func>(fn: F, args: Parameters<F>) {
  useEffect(() => fn(...args), args);
}
