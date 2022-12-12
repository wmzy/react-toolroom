import {CacheProvider} from '@@/types';
import {noop} from '@@/util';

export default function create<T, K extends any[]>({
  cacheTime,
  hash
}: {
  cacheTime: number;
  hash: (k: K) => string;
}): CacheProvider<T, K> {
  const map = new Map<string, [T, number]>();
  let useCount = 0;
  let timer: string | number | NodeJS.Timeout | undefined;
  return {
    get(key: K) {
      const k = hash(key);
      return map.get(k);
    },
    set(key: K, value: T) {
      map.set(hash(key), [value, Date.now()]);
    },
    delete(k: K) {
      map.delete(hash(k));
    },
    clear() {
      map.clear();
    },
    use() {
      if (cacheTime === Infinity) return noop;
      useCount++;
      let called = false;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      return () => {
        if (called) return;
        called = true;
        if (--useCount === 0) {
          timer = setTimeout(() => {
            map.clear();
            timer = undefined;
          }, cacheTime);
        }
      };
    }
  };
}
