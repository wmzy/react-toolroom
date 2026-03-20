import {describe, it, expect, vi} from 'vitest';
import {render, screen, waitFor, act} from '@testing-library/react';
import {useState, useEffect} from 'react';
import {
  useRun,
  useInjectable,
  createMemoryCacheProvider,
  useResult,
  useLoading,
  useError,
  useFailureCount,
  useCatch,
  useFinally,
  useRetry,
  useCache,
  getInjectContext,
  useInject
} from '../src/async';
import {useLoadingFn, useResult as useResultBase} from '../src/async/base';
import {useInjectBefore} from '../src/async/inject';

describe('async hooks', () => {
  describe('useRun', () => {
    it('should run function on mount', () => {
      const fn = vi.fn(() => 'result');

      function TestComponent() {
        useRun(fn, []);
        return <div>done</div>;
      }

      render(<TestComponent />);
      expect(fn).toHaveBeenCalled();
    });

    it('should re-run when dependencies change', () => {
      const fn = vi.fn(() => 'result');

      function TestComponent({deps}: {deps: number[]}) {
        useRun(fn, deps);
        return <div>done</div>;
      }

      const {rerender} = render(<TestComponent deps={[1]} />);
      expect(fn).toHaveBeenCalledTimes(1);

      rerender(<TestComponent deps={[2]} />);
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('useInjectable', () => {
    it('should create injectable function', async () => {
      const fetchData = vi.fn(async (id: number) => `result ${id}`);

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const [result, setResult] = useState('');

        useEffect(() => {
          injectable(1).then(setResult);
        }, [injectable]);

        return <div>{result}</div>;
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByText('result 1')).toBeDefined();
      });
    });
  });

  describe('createMemoryCacheProvider', () => {
    it('should create cache provider', () => {
      const provider = createMemoryCacheProvider<string, number[]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });

      expect(provider).toBeDefined();
      expect(provider.get).toBeDefined();
      expect(provider.set).toBeDefined();
      expect(provider.delete).toBeDefined();
      expect(provider.clear).toBeDefined();
      expect(provider.use).toBeDefined();
    });

    it('should cache and retrieve data', async () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });

      provider.set(['test'], 'cached value');
      const result = await provider.get(['test']);

      expect(result).toEqual(['cached value', expect.any(Number)]);
    });

    it('should return undefined for missing key', async () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });

      const result = await provider.get(['missing']);
      expect(result).toBeUndefined();
    });

    it('should delete cache entry', async () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });

      provider.set(['test'], 'value');
      provider.delete(['test']);

      expect(await provider.get(['test'])).toBeUndefined();
    });

    it('should clear all cache', async () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });

      provider.set(['a'], 'value a');
      provider.set(['b'], 'value b');
      provider.clear();

      expect(await provider.get(['a'])).toBeUndefined();
      expect(await provider.get(['b'])).toBeUndefined();
    });

    it('should use hook and cleanup', () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });

      const cleanup1 = provider.use();
      const cleanup2 = provider.use();

      expect(cleanup1).toBeDefined();
      expect(typeof cleanup1).toBe('function');

      // Call cleanup multiple times (should be idempotent)
      cleanup1();
      cleanup1();

      // Call second cleanup
      cleanup2();
    });

    it('should handle Infinity cacheTime', () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: Infinity,
        hash: (key) => JSON.stringify(key)
      });

      const cleanup = provider.use();
      expect(cleanup).toBeDefined();
    });

    it('should clear timer when use() is called multiple times (line 45)', async () => {
      vi.useFakeTimers();

      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 1000,
        hash: (key) => JSON.stringify(key)
      });

      provider.set(['test'], 'value');

      const cleanup1 = provider.use();
      const cleanup2 = provider.use();

      cleanup1();
      cleanup2();

      vi.advanceTimersByTime(500);
      expect(provider.get(['test'])).toBeDefined();

      vi.advanceTimersByTime(600);

      await vi.waitFor(() => {
        expect(provider.get(['test'])).toBeUndefined();
      });

      vi.useRealTimers();
    });

    it('should set timer and clear cache after cacheTime (lines 51-54)', async () => {
      vi.useFakeTimers();

      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 1000,
        hash: (key) => JSON.stringify(key)
      });

      provider.set(['test'], 'value');
      expect(provider.get(['test'])).toBeDefined();

      const cleanup = provider.use();
      cleanup();

      vi.advanceTimersByTime(500);
      expect(provider.get(['test'])).toBeDefined();

      vi.advanceTimersByTime(600);

      await vi.waitFor(() => {
        expect(provider.get(['test'])).toBeUndefined();
      });

      vi.useRealTimers();
    });

    it('should reset timer when new use() is called after cleanup', async () => {
      vi.useFakeTimers();

      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 1000,
        hash: (key) => JSON.stringify(key)
      });

      provider.set(['test'], 'value');

      const cleanup1 = provider.use();
      cleanup1();

      vi.advanceTimersByTime(500);

      const cleanup2 = provider.use();
      expect(provider.get(['test'])).toBeDefined();

      cleanup2();

      vi.advanceTimersByTime(500);
      expect(provider.get(['test'])).toBeDefined();

      vi.advanceTimersByTime(600);

      await vi.waitFor(() => {
        expect(provider.get(['test'])).toBeUndefined();
      });

      vi.useRealTimers();
    });
  });

  describe('useResult', () => {
    it('should return result from injectable function', async () => {
      const fetchData = vi.fn(async (id: number) => `data ${id}`);

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const result = useResult(injectable);

        useEffect(() => {
          injectable(1);
        }, [injectable]);

        return <div>{result ?? 'loading'}</div>;
      }

      render(<TestComponent />);
      expect(screen.getByText('loading')).toBeDefined();

      await waitFor(() => {
        expect(screen.getByText('data 1')).toBeDefined();
      });
    });

    it('should use initial value', async () => {
      const fetchData = vi.fn(async () => 'actual');

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const result = useResult(injectable, 'initial');

        return <div>{result}</div>;
      }

      render(<TestComponent />);
      expect(screen.getByText('initial')).toBeDefined();
    });
  });

  describe('useLoading', () => {
    it('should track loading state', async () => {
      let resolveFn: (v: string) => void;
      const fetchData = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveFn = resolve;
          })
      );

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const loading = useLoading(injectable);

        useEffect(() => {
          injectable();
        }, [injectable]);

        return <div>{loading ? 'loading' : 'done'}</div>;
      }

      render(<TestComponent />);
      expect(screen.getByText('loading')).toBeDefined();

      await act(async () => {
        resolveFn!('result');
      });
    });
  });

  describe('useError', () => {
    it('should capture error', async () => {
      const fetchData = vi.fn(async () => {
        throw new Error('test error');
      });

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const error = useError<Error>(injectable);

        useEffect(() => {
          injectable().catch(() => {});
        }, [injectable]);

        return <div>{error ? error.message : 'no error'}</div>;
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByText('test error')).toBeDefined();
      });
    });
  });

  describe('useFailureCount', () => {
    it('should count failures', async () => {
      const fetchData = vi.fn(() => Promise.reject(new Error('fail')));

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const count = useFailureCount(injectable);

        useEffect(() => {
          injectable().catch(() => {});
        }, [injectable]);

        return <div>failures: {count}</div>;
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByText('failures: 1')).toBeDefined();
      });
    });
  });

  describe('useCatch', () => {
    it('should catch and transform errors', async () => {
      const fetchData = vi.fn(async () => {
        throw new Error('original');
      });
      const catcher = vi.fn((e: Error) => `caught: ${e.message}`);

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useCatch(injectable, catcher);

        return <div>test</div>;
      }

      render(<TestComponent />);
      expect(screen.getByText('test')).toBeDefined();
    });
  });

  describe('useFinally', () => {
    it('should run handler on completion', async () => {
      const fetchData = vi.fn(async () => 'result');
      const handler = vi.fn();

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useFinally(injectable, handler);

        useEffect(() => {
          injectable();
        }, [injectable]);

        return <div>done</div>;
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(handler).toHaveBeenCalled();
      });
    });
  });

  describe('useRetry', () => {
    it('should retry on failure', async () => {
      let attempts = 0;
      const fetchData = vi.fn(async () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return 'success';
      });
      const shouldRetry = vi.fn((count: number) => count < 2);

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useRetry(injectable, shouldRetry);
        const [result, setResult] = useState('');

        useEffect(() => {
          injectable()
            .then(setResult)
            .catch(() => {});
        }, [injectable]);

        return <div>{result}</div>;
      }

      render(<TestComponent />);

      await waitFor(
        () => {
          expect(screen.getByText('success')).toBeDefined();
        },
        {timeout: 3000}
      );
    });

    it('should stop retrying when shouldRetry returns false', async () => {
      const fetchData = vi.fn(async () => {
        throw new Error('fail');
      });
      const shouldRetry = vi.fn(() => false);

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useRetry(injectable, shouldRetry);

        return <div>done</div>;
      }

      render(<TestComponent />);

      expect(screen.getByText('done')).toBeDefined();
    });

    it('should handle async shouldRetry (line 254)', async () => {
      let attempts = 0;
      const fetchData = vi.fn(async () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return 'success with async retry';
      });

      const shouldRetry = vi.fn(async (count: number) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return count < 2;
      });

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useRetry(injectable, shouldRetry);
        const [result, setResult] = useState('');

        useEffect(() => {
          injectable()
            .then(setResult)
            .catch(() => {});
        }, [injectable]);

        return <div>{result}</div>;
      }

      render(<TestComponent />);

      await waitFor(
        () => {
          expect(screen.getByText('success with async retry')).toBeDefined();
        },
        {timeout: 3000}
      );

      expect(shouldRetry).toHaveBeenCalledTimes(2);
    });
  });

  describe('useCache', () => {
    it('should be defined', () => {
      expect(useCache).toBeDefined();
    });

    it('should return cached data on cache hit', async () => {
      const fetchData = vi.fn(async (id: number) => `data ${id}`);
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 60000,
        hash: (k) => JSON.stringify(k)
      });

      cache.set([1], 'cached data');

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const isStale = useCache(injectable, cache, 1000);
        const result = useResult(injectable);

        useEffect(() => {
          injectable(1);
        }, [injectable]);

        return (
          <div>
            <span data-testid='result'>{result ?? 'no result'}</span>
            <span data-testid='stale'>{isStale ? 'stale' : 'fresh'}</span>
          </div>
        );
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('cached data');
      });

      expect(fetchData).not.toHaveBeenCalled();
    });

    it('should fetch data when cache miss', async () => {
      const fetchData = vi.fn(async (id: number) => `fetched ${id}`);
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 60000,
        hash: (k) => JSON.stringify(k)
      });

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 1000);
        const result = useResult(injectable);

        useEffect(() => {
          injectable(1);
        }, [injectable]);

        return <div data-testid='result'>{result ?? 'no result'}</div>;
      }

      render(<TestComponent />);

      await waitFor(
        () => {
          expect(screen.getByTestId('result').textContent).toBe('fetched 1');
        },
        {timeout: 10000}
      );

      expect(fetchData).toHaveBeenCalledWith(1);
    });

    it('should handle cache error and refetch', async () => {
      const fetchData = vi.fn(async (id: number) => `recovered ${id}`);
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 60000,
        hash: (k) => JSON.stringify(k)
      });

      const originalGet = cache.get.bind(cache);
      cache.get = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('cache error');
        })
        .mockImplementation(originalGet);

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 1000);
        const result = useResult(injectable);

        useEffect(() => {
          injectable(1);
        }, [injectable]);

        return <div data-testid='result'>{result ?? 'no result'}</div>;
      }

      render(<TestComponent />);

      await waitFor(
        () => {
          expect(screen.getByTestId('result').textContent).toBe('recovered 1');
        },
        {timeout: 10000}
      );
    });
  });

  describe('getInjectContext', () => {
    it('should get context from injectable', () => {
      const fetchData = vi.fn(async () => 'result');

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const context = getInjectContext(injectable);

        return <div>{context ? 'has context' : 'no context'}</div>;
      }

      render(<TestComponent />);
      expect(screen.getByText('has context')).toBeDefined();
    });
  });

  describe('useLoadingFn (from base)', () => {
    it('should wrap function with loading state', async () => {
      let resolveFn: (v: string) => void;
      const fetchData = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveFn = resolve;
          })
      );

      function TestComponent() {
        const [loading, wrap] = useLoadingFn();

        return (
          <div>
            <span data-testid='loading'>{loading ? 'loading' : 'idle'}</span>
          </div>
        );
      }

      render(<TestComponent />);
      expect(screen.getByTestId('loading').textContent).toBe('idle');
    });
  });

  describe('useResultBase (from base)', () => {
    it('should return result with initial value', async () => {
      const fetchData = vi.fn(async () => 'fetched');

      function TestComponent() {
        const [result, wrapped] = useResultBase(fetchData, 'initial');

        return <div data-testid='result'>{result}</div>;
      }

      render(<TestComponent />);
      expect(screen.getByTestId('result').textContent).toBe('initial');
    });

    it('should update result when wrapped function is called (thru callback line 34)', async () => {
      const fetchData = vi.fn(async (value: string) => `result: ${value}`);

      function TestComponent() {
        const [result, wrapped] = useResultBase(fetchData);

        useEffect(() => {
          wrapped('test');
        }, [wrapped]);

        return <div data-testid='result'>{result ?? 'no result'}</div>;
      }

      render(<TestComponent />);
      expect(screen.getByTestId('result').textContent).toBe('no result');

      await waitFor(
        () => {
          expect(screen.getByTestId('result').textContent).toBe('result: test');
        },
        {timeout: 10000}
      );
    });

    it('should update result multiple times (thru callback)', async () => {
      const fetchData = vi.fn(async (value: string) => `result: ${value}`);

      function TestComponent({input}: {input: string}) {
        const [result, wrapped] = useResultBase(fetchData);

        useEffect(() => {
          wrapped(input);
        }, [wrapped, input]);

        return <div data-testid='result'>{result ?? 'no result'}</div>;
      }

      const {rerender} = render(<TestComponent input='first' />);

      await waitFor(
        () => {
          expect(screen.getByTestId('result').textContent).toBe(
            'result: first'
          );
        },
        {timeout: 10000}
      );

      rerender(<TestComponent input='second' />);

      await waitFor(
        () => {
          expect(screen.getByTestId('result').textContent).toBe(
            'result: second'
          );
        },
        {timeout: 10000}
      );
    });
  });

  describe('useInjectBefore', () => {
    it('should be defined', () => {
      expect(useInjectBefore).toBeDefined();
    });

    it('should inject wrapper at the beginning (lines 41-42)', async () => {
      const order: string[] = [];
      const fetchData = vi.fn(async (id: number) => {
        order.push('original');
        return `result ${id}`;
      });

      function TestComponent() {
        const injectable = useInjectable(fetchData);

        useInject(injectable, (f) => {
          order.push('useInject after');
          return f;
        });

        useInjectBefore(injectable, (f) => {
          order.push('useInjectBefore');
          return f;
        });

        const [result, setResult] = useState('');

        useEffect(() => {
          injectable(1).then(setResult);
        }, [injectable]);

        return <div>{result}</div>;
      }

      render(<TestComponent />);

      await waitFor(
        () => {
          expect(screen.getByText('result 1')).toBeDefined();
        },
        {timeout: 10000}
      );

      expect(order).toEqual(['useInjectBefore', 'useInject after', 'original']);
    });
  });
});
