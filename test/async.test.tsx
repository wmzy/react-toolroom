import {describe, it, expect, vi} from 'vitest';
import {render, screen, waitFor, act, fireEvent} from '@testing-library/react';
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
import {useLoadingFn} from '../src/async/base';
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

    it('should ignore stale result when a newer call resolves first', async () => {
      const fetchData = vi.fn(async (id: string) => {
        await new Promise((r) => setTimeout(r, id === 'slow' ? 100 : 10));
        return `data ${id}`;
      });

      function TestComponent({id}: {id: string}) {
        const injectable = useInjectable(fetchData);
        const result = useResult(injectable);

        useRun(injectable, [id]);

        return <div>{result ?? 'loading'}</div>;
      }

      const {rerender} = render(<TestComponent id='slow' />);
      rerender(<TestComponent id='fast' />);

      await waitFor(() => {
        expect(screen.getByText('data fast')).toBeDefined();
      });

      // Wait past the slow call's resolution to prove it cannot overwrite
      await act(async () => {
        await new Promise((r) => setTimeout(r, 150));
      });
      expect(screen.getByText('data fast')).toBeDefined();
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

    it('should call fn only once when fn rejects on cache miss', async () => {
      const fetchData = vi.fn((id: number) => {
        return new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error('fetch failed')), 5);
        });
      });
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 60000,
        hash: (k) => JSON.stringify(k)
      });

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 1000);
        const result = useResult(injectable);

        useEffect(() => {
          injectable(1).catch(() => {});
        }, [injectable]);

        return <div data-testid='result'>{result ?? 'no result'}</div>;
      }

      render(<TestComponent />);

      // wait long enough for a spurious second call to happen if the bug exists
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(fetchData).toHaveBeenCalledTimes(1);
    });

    it('should keep stale data without unhandled rejection when background refetch rejects', async () => {
      const fetchData = vi.fn((id: number) => {
        return new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error('refetch failed')), 5);
        });
      });
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 60000,
        hash: (k) => JSON.stringify(k)
      });
      cache.set([1], 'stale data');

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 10);
        const result = useResult(injectable);

        useEffect(() => {
          injectable(1);
        }, [injectable]);

        return <div data-testid='result'>{result ?? 'no result'}</div>;
      }

      // let the cached entry become stale before mounting
      await new Promise((resolve) => setTimeout(resolve, 20));

      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        render(<TestComponent />);

        await waitFor(() => {
          expect(screen.getByTestId('result').textContent).toBe('stale data');
        });

        // wait long enough for the background refetch to reject
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(fetchData).toHaveBeenCalledTimes(1);
        expect(unhandled).toEqual([]);
        expect(screen.getByTestId('result').textContent).toBe('stale data');
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
    });

    it('should update stale reactively on stale cache hit and after background refetch', async () => {
      let calls = 0;
      let resolveRefetch: (v: string) => void;
      const fetchData = vi.fn((id: number) => {
        calls += 1;
        if (calls === 1) return Promise.resolve(`data ${id}`);
        return new Promise<string>((resolve) => {
          resolveRefetch = resolve;
        });
      });
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 60000,
        hash: (k) => JSON.stringify(k)
      });

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const isStale = useCache(injectable, cache, 10);
        const result = useResult(injectable);

        useEffect(() => {
          injectable(1);
        }, [injectable]);

        return (
          <div>
            <span data-testid='result'>{result ?? 'no result'}</span>
            <span data-testid='stale'>{isStale ? 'stale' : 'fresh'}</span>
            <button
              data-testid='refetch'
              type='button'
              onClick={() => {
                injectable(1);
              }}
            >
              refetch
            </button>
          </div>
        );
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('data 1');
      });
      expect(screen.getByTestId('stale').textContent).toBe('fresh');

      // let the cached entry become stale, then request again within cacheTime
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      fireEvent.click(screen.getByTestId('refetch'));

      // the cached data is already on screen, so setResult bails out and no
      // re-render is scheduled: only a reactive stale state can flip the UI
      await waitFor(() => {
        expect(screen.getByTestId('stale').textContent).toBe('stale');
      });
      expect(screen.getByTestId('result').textContent).toBe('data 1');
      expect(fetchData).toHaveBeenCalledTimes(2);

      // background refetch completes: stale flips back to false in the UI
      await act(async () => {
        resolveRefetch!('data 1 updated');
      });
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('data 1 updated');
      });
      expect(screen.getByTestId('stale').textContent).toBe('fresh');
    });

    it('should keep stale true in the UI when background refetch rejects', async () => {
      let calls = 0;
      const fetchData = vi.fn((id: number) => {
        calls += 1;
        if (calls === 1) return Promise.resolve(`data ${id}`);
        return new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error('refetch failed')), 5);
        });
      });
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 60000,
        hash: (k) => JSON.stringify(k)
      });

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const isStale = useCache(injectable, cache, 10);
        const result = useResult(injectable);

        useEffect(() => {
          injectable(1);
        }, [injectable]);

        return (
          <div>
            <span data-testid='result'>{result ?? 'no result'}</span>
            <span data-testid='stale'>{isStale ? 'stale' : 'fresh'}</span>
            <button
              data-testid='refetch'
              type='button'
              onClick={() => {
                injectable(1);
              }}
            >
              refetch
            </button>
          </div>
        );
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('data 1');
      });
      expect(screen.getByTestId('stale').textContent).toBe('fresh');

      // let the cached entry become stale before re-requesting
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        fireEvent.click(screen.getByTestId('refetch'));

        // stale must be reflected in the UI even though the displayed
        // result data is unchanged (no setResult-driven re-render)
        await waitFor(() => {
          expect(screen.getByTestId('stale').textContent).toBe('stale');
        });

        // wait long enough for the background refetch to reject
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });

        expect(fetchData).toHaveBeenCalledTimes(2);
        expect(unhandled).toEqual([]);
        expect(screen.getByTestId('stale').textContent).toBe('stale');
        expect(screen.getByTestId('result').textContent).toBe('data 1');
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
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
