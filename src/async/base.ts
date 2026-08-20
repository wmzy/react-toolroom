import {AsyncFunc} from '@@/types';
import {useState} from 'react';

export function useLoadingFn() {
  const [count, setCount] = useState(0);
  const withLoading = <P extends Promise<any>>(p: P) => (
    setCount((c) => c + 1),
    p.finally(() => setCount((c) => c - 1))
  );
  const wrap = <AF extends AsyncFunc>(fn: AF) =>
    ((...args: Parameters<AF>) => withLoading(fn(...args))) as AF;
  return [Boolean(count), wrap] as const;
}
