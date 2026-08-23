import {describe, it, expect, vi} from 'vitest';
import {render, screen, waitFor, act, fireEvent} from '@testing-library/react';
import {
  memo,
  StrictMode,
  Suspense,
  useState,
  useEffect,
  startTransition
} from 'react';
import {
  useRun,
  useInjectable,
  createMemoryCacheProvider,
  useResult,
  useSuspenseResult,
  useLoading,
  useInitialLoading,
  useError,
  useFailureCount,
  useCatch,
  useFinally,
  useRetry,
  useCache,
  useInvalidate,
  useMutation,
  invalidate,
  getInjectContext,
  useInject,
  useDedup,
  usePolling,
  useFocusRevalidate,
  stableHash
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

    it('should not re-run when a hash reports structurally unchanged args', () => {
      const fn = vi.fn((query: {page: number}) => Promise.resolve('ok'));

      function TestComponent({page}: {page: number}) {
        // Fresh array/object literals on every render: without `hash` the
        // reference comparison would re-run the effect on each rerender.
        useRun(fn, [{page}], {hash: stableHash});
        return null;
      }

      const {rerender} = render(<TestComponent page={1} />);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith({page: 1});

      // Same structure, new references → no rerun.
      rerender(<TestComponent page={1} />);
      rerender(<TestComponent page={1} />);
      expect(fn).toHaveBeenCalledTimes(1);

      // Structural change (page) → rerun with the args of that render.
      rerender(<TestComponent page={2} />);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith({page: 2});
    });

    it('should support plain (non-injectable) functions with the signal option', () => {
      const received: {id: number; signal: AbortSignal}[] = [];
      // Deliberately NOT wrapped in useInjectable: useRun must detect it
      // via isInjectable and run it without the injection bridge.
      const fn = (id: number, signal: AbortSignal) => {
        received.push({id, signal});
        return Promise.resolve('ok');
      };

      function TestComponent({id}: {id: number}) {
        useRun(fn, [id], {signal: true});
        return null;
      }

      const {rerender} = render(<TestComponent id={1} />);
      expect(received.length).toBe(1);
      expect(received[0]!.signal).toBeInstanceOf(AbortSignal);
      expect(received[0]!.signal.aborted).toBe(false);

      rerender(<TestComponent id={2} />);
      expect(received.length).toBe(2);
      // the dependency change aborted the previous run's signal
      expect(received[0]!.signal.aborted).toBe(true);
      expect(received[1]!.signal.aborted).toBe(false);
    });

    it('should bridge a duck-typed (cross-realm) signal onto the callContext', async () => {
      const observed: unknown[] = [];
      const fetchData = vi.fn(async (id: number) => `result ${id}`);
      // A plain object standing in for a signal from another realm (e.g. an
      // iframe's AbortSignal): `instanceof` fails, duck-typing must not.
      const foreignSignal = {
        aborted: false,
        addEventListener() {}
      };

      let fetchValue!: ReturnType<typeof useInjectable>;
      function TestComponent() {
        fetchValue = useInjectable(fetchData);
        // Registers the attachSignal bridge (bridge registration happens
        // regardless of the `signal` option).
        useRun(fetchValue, [1]);
        useInject(fetchValue, (f, callContext) => (...args: any[]) => {
          const result = f(...args);
          // The bridge layer runs inside `f`, so `signal` (if bridged)
          // is already on the shared callContext by the time we look.
          observed.push(callContext.signal);
          return result;
        });
        return null;
      }

      render(<TestComponent />);
      // The mount run passes no trailing signal, so nothing is bridged.
      expect(observed).toEqual([undefined]);

      await act(async () => {
        await fetchValue(1, foreignSignal);
      });
      expect(observed[1]).toBe(foreignSignal);
      expect(fetchData).toHaveBeenCalledWith(1, foreignSignal);
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

    it('should not duplicate wrapper when injecting component re-renders', async () => {
      const applied = vi.fn();
      let holder!: (...args: any[]) => Promise<any>;
      let bump!: () => void;

      function Injector({fn}: {fn: any}) {
        const [, setN] = useState(0);
        bump = () => setN((n) => n + 1);
        useInject(
          fn,
          (f: any) =>
            ((...args: any[]) => {
              applied();
              return f(...args);
            }) as any
        );
        return null;
      }

      function Owner() {
        const f = useInjectable(async () => 'result');
        holder = f;
        return <Injector fn={f} />;
      }

      render(<Owner />);
      // Injector 独自重渲染两次（Owner 不重渲染，注入列表不会被重置）
      act(() => bump());
      act(() => bump());
      await act(async () => {
        await holder();
      });
      expect(applied).toHaveBeenCalledTimes(1);
    });

    it('should keep injections when owner re-renders and injector is memoized', async () => {
      const applied = vi.fn();
      let holder!: (...args: any[]) => Promise<any>;

      const Injector = memo(function Injector({fn}: {fn: any}) {
        useInject(
          fn,
          (f: any) =>
            ((...args: any[]) => {
              applied();
              return f(...args);
            }) as any
        );
        return null;
      });

      function Owner() {
        const f = useInjectable(async () => 'result');
        holder = f;
        const [, setN] = useState(0);
        return (
          <div>
            <Injector fn={f} />
            <button
              type='button'
              data-testid='rerender'
              onClick={() => setN((n) => n + 1)}
            />
          </div>
        );
      }

      render(<Owner />);
      // Owner 重渲染会重置注入列表，但 memo 的 Injector 被跳过不会重新注册
      fireEvent.click(screen.getByTestId('rerender'));
      await act(async () => {
        await holder();
      });
      expect(applied).toHaveBeenCalledTimes(1);
    });

    it('should remove wrapper when injecting component unmounts', async () => {
      const applied = vi.fn();
      const holderRef: {
        current?: (...args: any[]) => Promise<any>;
      } = {};
      let toggle!: () => void;

      function Injector() {
        // MemoOwner 先于本组件渲染，此处 holderRef.current 必已赋值
        useInject(
          holderRef.current as any,
          (f: any) =>
            ((...args: any[]) => {
              applied();
              return f(...args);
            }) as any
        );
        return null;
      }

      const MemoOwner = memo(function Owner() {
        holderRef.current = useInjectable(async () => 'result');
        return null;
      });

      function App() {
        const [show, setS] = useState(true);
        toggle = () => setS((v) => !v);
        return (
          <>
            <MemoOwner />
            {show && <Injector />}
          </>
        );
      }

      render(<App />);
      const holder = holderRef.current!;
      await act(async () => {
        await holder();
      });
      expect(applied).toHaveBeenCalledTimes(1);
      // 卸载 Injector 时 App 重渲染，但 memo 的 Owner 不重渲染（无重置掩蔽），
      // 注入组件卸载后其包装器不应继续生效
      act(() => toggle());
      await act(async () => {
        await holder();
      });
      expect(applied).toHaveBeenCalledTimes(1);
    });

    it('should apply wrapper exactly once under StrictMode', async () => {
      const applied = vi.fn();
      let holder!: (...args: any[]) => Promise<any>;

      function Owner() {
        const f = useInjectable(async () => 'result');
        holder = f;
        return <Injector fn={f} />;
      }

      function Injector({fn}: {fn: any}) {
        useInject(
          fn,
          (f: any) =>
            ((...args: any[]) => {
              applied();
              return f(...args);
            }) as any
        );
        return null;
      }

      render(
        <StrictMode>
          <Owner />
        </StrictMode>
      );
      await act(async () => {
        await holder();
      });
      expect(applied).toHaveBeenCalledTimes(1);
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

    it('should round-trip dehydrate and hydrate with timestamps preserved', async () => {
      const hash = (key: [string]) => JSON.stringify(key);
      const server = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash
      });

      server.set(['a'], 'value a');
      const [, timestamp] = (await server.get(['a']))!;

      // Transport via JSON exactly like shipping cache state from server to
      // client — the payload must stay a plain, JSON-serializable object.
      const payload = JSON.parse(JSON.stringify(server.dehydrate!()));

      const client = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash
      });
      client.hydrate!(payload);

      expect(await client.get(['a'])).toEqual(['value a', timestamp]);
    });

    it('should delete only entries matching the prefix', async () => {
      const provider = createMemoryCacheProvider<string, [string, string]>({
        cacheTime: 60000,
        hash: ([scope, id]) => scope + ':' + id
      });

      provider.set(['user', '1'], 'user 1');
      provider.set(['user', '2'], 'user 2');
      provider.set(['post', '1'], 'post 1');

      provider.deletePrefix!('user:');

      expect(await provider.get(['user', '1'])).toBeUndefined();
      expect(await provider.get(['user', '2'])).toBeUndefined();
      expect(await provider.get(['post', '1'])).toEqual([
        'post 1',
        expect.any(Number)
      ]);
    });

    it('should merge hydrate data without clearing existing entries', async () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });

      provider.set(['local'], 'local value');
      provider.hydrate!({[JSON.stringify(['server'])]: ['server value', 123]});

      expect(await provider.get(['server'])).toEqual(['server value', 123]);
      expect(await provider.get(['local'])).toEqual([
        'local value',
        expect.any(Number)
      ]);
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
    it('should broadcast result to every subscribed component', async () => {
      const resolvers: ((v: string) => void)[] = [];
      const fetchData = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolvers.push(resolve);
          })
      );

      function Subscriber({
        injectable,
        label
      }: {
        injectable: () => Promise<string>;
        label: string;
      }) {
        const result = useResult(injectable);
        return <span data-testid={label}>{result ?? 'loading'}</span>;
      }

      function TestComponent({showThird}: {showThird: boolean}) {
        const injectable = useInjectable(fetchData);
        useRun(injectable, []);

        return (
          <div>
            <Subscriber injectable={injectable} label='a' />
            <Subscriber injectable={injectable} label='b' />
            {showThird && <Subscriber injectable={injectable} label='c' />}
          </div>
        );
      }

      // StrictMode double-invokes render and effects; subscriptions stay
      // deduplicated because Set#add is idempotent, so the effect fires twice
      const {rerender} = render(
        <StrictMode>
          <TestComponent showThird={false} />
        </StrictMode>
      );
      expect(fetchData).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('a').textContent).toBe('loading');
      expect(screen.getByTestId('b').textContent).toBe('loading');

      await act(async () => {
        for (const resolve of resolvers) resolve('shared data');
      });
      // both subscribers received the broadcast
      expect(screen.getByTestId('a').textContent).toBe('shared data');
      expect(screen.getByTestId('b').textContent).toBe('shared data');

      // a late subscriber starts from the shared last result immediately
      rerender(
        <StrictMode>
          <TestComponent showThird={true} />
        </StrictMode>
      );
      expect(screen.getByTestId('c').textContent).toBe('shared data');
      expect(fetchData).toHaveBeenCalledTimes(2);
    });

    it('should keep subscribers consistent when a result lands during a transition', async () => {
      const resolvers: ((v: string) => void)[] = [];
      const fetchData = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolvers.push(resolve);
          })
      );

      function Subscriber({
        injectable,
        label
      }: {
        injectable: () => Promise<string>;
        label: string;
      }) {
        const result = useResult(injectable);
        return <span data-testid={label}>{result ?? 'loading'}</span>;
      }

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const [showSecond, setShowSecond] = useState(false);
        useRun(injectable, []);

        return (
          <div>
            <button
              type='button'
              onClick={() => startTransition(() => setShowSecond(true))}
            >
              show
            </button>
            <Subscriber injectable={injectable} label='a' />
            {showSecond && <Subscriber injectable={injectable} label='b' />}
          </div>
        );
      }

      render(<TestComponent />);
      expect(screen.getByTestId('a').textContent).toBe('loading');

      // Mount a second subscriber at transition priority, then resolve the
      // in-flight call: uSES-driven updates at transition priority must not
      // tear — both subscribers observe the same store snapshot.
      fireEvent.click(screen.getByText('show'));
      await act(async () => {
        startTransition(() => {
          for (const resolve of resolvers) resolve('shared');
        });
        // flush the promise chain inside act
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('a').textContent).toBe('shared');
      expect(screen.getByTestId('b').textContent).toBe('shared');
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

    it('should stay loading until every concurrent call settles', async () => {
      const resolvers: ((v: string) => void)[] = [];
      const fetchData = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolvers.push(resolve);
          })
      );

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const loading = useLoading(injectable);

        return (
          <div>
            <button type='button' onClick={() => injectable()}>
              run
            </button>
            <div>{loading ? 'loading' : 'done'}</div>
          </div>
        );
      }

      render(<TestComponent />);
      // two overlapping calls: the shared count goes 0 → 1 → 2
      fireEvent.click(screen.getByText('run'));
      fireEvent.click(screen.getByText('run'));
      expect(screen.getByText('loading')).toBeDefined();

      // the first call settles; the count must drop to 1, not 0
      await act(async () => {
        resolvers[0]!('first');
      });
      expect(screen.getByText('loading')).toBeDefined();

      // the second call settles; the count returns to exactly 0
      await act(async () => {
        resolvers[1]!('second');
      });
      expect(screen.getByText('done')).toBeDefined();
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

    it('should share the error with a component mounting after the failure', async () => {
      const fetchData = vi.fn(async () => {
        throw new Error('shared failure');
      });

      function Watcher({
        injectable,
        label
      }: {
        injectable: () => Promise<string>;
        label: string;
      }) {
        const error = useError<Error>(injectable);
        return (
          <span data-testid={label}>{error ? error.message : 'no error'}</span>
        );
      }

      function TestComponent({showLate}: {showLate: boolean}) {
        const injectable = useInjectable(fetchData);
        useEffect(() => {
          injectable().catch(() => {});
        }, [injectable]);
        return (
          <div>
            <Watcher injectable={injectable} label='early' />
            {showLate && <Watcher injectable={injectable} label='late' />}
          </div>
        );
      }

      const {rerender} = render(<TestComponent showLate={false} />);
      await waitFor(() => {
        expect(screen.getByTestId('early').textContent).toBe('shared failure');
      });

      // Behavior change: the error now lives on the injectable-level
      // shared store, so a component mounting after the failure starts
      // from the shared error instead of a fresh local `undefined`.
      rerender(<TestComponent showLate={true} />);
      expect(screen.getByTestId('late').textContent).toBe('shared failure');
    });

    it('should broadcast the error to every subscribed component', async () => {
      const rejecters: ((e: Error) => void)[] = [];
      const fetchData = vi.fn(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejecters.push(reject);
          })
      );

      function Watcher({
        injectable,
        label
      }: {
        injectable: () => Promise<string>;
        label: string;
      }) {
        const error = useError<Error>(injectable);
        return (
          <span data-testid={label}>{error ? error.message : 'no error'}</span>
        );
      }

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        return (
          <div>
            <Watcher injectable={injectable} label='a' />
            <Watcher injectable={injectable} label='b' />
            <button
              type='button'
              onClick={() => void injectable().catch(() => {})}
            >
              run
            </button>
          </div>
        );
      }

      render(<TestComponent />);
      expect(screen.getByTestId('a').textContent).toBe('no error');
      expect(screen.getByTestId('b').textContent).toBe('no error');

      await act(async () => {
        fireEvent.click(screen.getByText('run'));
        rejecters[0]!(new Error('boom'));
      });
      // both subscribers received the broadcast together
      expect(screen.getByTestId('a').textContent).toBe('boom');
      expect(screen.getByTestId('b').textContent).toBe('boom');
    });

    it('should not let a slow old failure clobber a newer success', async () => {
      const deferred: {
        resolve: (v: string) => void;
        reject: (e: Error) => void;
      }[] = [];
      const fetchData = vi.fn(
        () =>
          new Promise<string>((resolve, reject) => {
            deferred.push({resolve, reject});
          })
      );

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const error = useError<Error>(injectable);
        const count = useFailureCount(injectable);
        return (
          <div>
            <span>{error ? error.message : 'no error'}</span>
            <span>failures: {count}</span>
            <button
              type='button'
              onClick={() => void injectable().catch(() => {})}
            >
              run
            </button>
          </div>
        );
      }

      render(<TestComponent />);
      // two overlapping calls; the older one is still pending
      await act(async () => {
        fireEvent.click(screen.getByText('run'));
      });
      await act(async () => {
        fireEvent.click(screen.getByText('run'));
      });

      // the newer call succeeds first
      await act(async () => {
        deferred[1]!.resolve('fresh');
      });
      expect(screen.getByText('no error')).toBeDefined();
      expect(screen.getByText('failures: 0')).toBeDefined();

      // …then the older call fails: dropped by the seq watermark.
      // Behavior change: the old per-component setState had no such guard,
      // the late failure used to overwrite the newer success.
      await act(async () => {
        deferred[0]!.reject(new Error('stale failure'));
      });
      expect(screen.getByText('no error')).toBeDefined();
      expect(screen.getByText('failures: 0')).toBeDefined();
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

    it('should reset the count and clear the error on success', async () => {
      let fail = true;
      const fetchData = vi.fn(async () => {
        if (fail) throw new Error('flaky');
        return 'ok';
      });

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const error = useError<Error>(injectable);
        const count = useFailureCount(injectable);
        return (
          <div>
            <span>{error ? error.message : 'no error'}</span>
            <span>failures: {count}</span>
            <button
              type='button'
              onClick={() => void injectable().catch(() => {})}
            >
              run
            </button>
          </div>
        );
      }

      render(<TestComponent />);
      await act(async () => {
        fireEvent.click(screen.getByText('run'));
      });
      expect(screen.getByText('flaky')).toBeDefined();
      expect(screen.getByText('failures: 1')).toBeDefined();

      fail = false;
      await act(async () => {
        fireEvent.click(screen.getByText('run'));
      });
      // a success clears the shared error and resets the tally to 0
      expect(screen.getByText('no error')).toBeDefined();
      expect(screen.getByText('failures: 0')).toBeDefined();
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

    it('should broadcast cached data immediately on hit and updated data after background refetch', async () => {
      let calls = 0;
      let resolveRefetch!: (v: string) => void;
      const fetchData = vi.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.resolve('v1');
        return new Promise<string>((resolve) => {
          resolveRefetch = resolve;
        });
      });
      const cache = createMemoryCacheProvider<string, any[]>({
        cacheTime: 60000,
        hash: (k) => JSON.stringify(k)
      });

      function Subscriber({
        injectable,
        label
      }: {
        injectable: () => Promise<string>;
        label: string;
      }) {
        const result = useResult(injectable);
        return <span data-testid={label}>{result ?? 'no result'}</span>;
      }

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 10);
        useRun(injectable, []);

        return (
          <div>
            <Subscriber injectable={injectable} label='a' />
            <Subscriber injectable={injectable} label='b' />
            <button
              data-testid='refetch'
              type='button'
              onClick={() => {
                injectable();
              }}
            >
              refetch
            </button>
          </div>
        );
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByTestId('a').textContent).toBe('v1');
        expect(screen.getByTestId('b').textContent).toBe('v1');
      });

      // let the cached entry become stale, then request again
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('refetch'));
      });

      // stale hit: the cached data is broadcast immediately, so both
      // subscribers keep rendering it while the refetch is still pending
      expect(screen.getByTestId('a').textContent).toBe('v1');
      expect(screen.getByTestId('b').textContent).toBe('v1');
      expect(fetchData).toHaveBeenCalledTimes(2);

      // background refetch completes: the fresh data is broadcast to both
      await act(async () => {
        resolveRefetch!('v2');
      });
      await waitFor(() => {
        expect(screen.getByTestId('a').textContent).toBe('v2');
        expect(screen.getByTestId('b').textContent).toBe('v2');
      });
    });

    it('should share one stale flag across useCache consumers of the same injectable', async () => {
      let calls = 0;
      let resolveRefetch!: (v: string) => void;
      const fetchData = vi.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.resolve('v1');
        return new Promise<string>((resolve) => {
          resolveRefetch = resolve;
        });
      });
      const cache = createMemoryCacheProvider<string, any[]>({
        cacheTime: 60000,
        hash: (k) => JSON.stringify(k)
      });

      function Consumer({
        injectable,
        label
      }: {
        injectable: () => Promise<string>;
        label: string;
      }) {
        const isStale = useCache(injectable, cache, 10);
        return <span data-testid={label}>{isStale ? 'stale' : 'fresh'}</span>;
      }

      function TestComponent() {
        const [showB, setShowB] = useState(false);
        const injectable = useInjectable(fetchData);
        useRun(injectable, []);

        return (
          <div>
            <Consumer injectable={injectable} label='a' />
            {showB && <Consumer injectable={injectable} label='b' />}
            <button
              data-testid='refetch'
              type='button'
              onClick={() => {
                injectable();
              }}
            >
              refetch
            </button>
            <button
              data-testid='mount-b'
              type='button'
              onClick={() => {
                setShowB(true);
              }}
            >
              mount b
            </button>
          </div>
        );
      }

      render(<TestComponent />);

      // initial fetch: the single consumer is fresh
      await waitFor(() => {
        expect(screen.getByTestId('a').textContent).toBe('fresh');
      });

      // let the cached entry become stale, then request again: consumer a
      // flips to stale while the background refetch is held pending
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('refetch'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('a').textContent).toBe('stale');
      });

      // a second consumer mounting mid-refetch reads the same shared stale
      // flag instead of starting from a local false
      await act(async () => {
        fireEvent.click(screen.getByTestId('mount-b'));
      });
      expect(screen.getByTestId('b').textContent).toBe('stale');

      // background refetch completes: both consumers flip back together
      await act(async () => {
        resolveRefetch!('v2');
      });
      await waitFor(() => {
        expect(screen.getByTestId('a').textContent).toBe('fresh');
        expect(screen.getByTestId('b').textContent).toBe('fresh');
      });
    });
  });

  describe('useInvalidate', () => {
    it('should be defined', () => {
      expect(useInvalidate).toBeDefined();
    });

    it('should delete the cached key and refetch on invalidate', async () => {
      const resolveQueue: Array<(v: string) => void> = [];
      const fetchData = vi.fn(
        (id: number) =>
          new Promise<string>((resolve) => {
            resolveQueue.push(resolve);
          })
      );
      const cache = createMemoryCacheProvider<string, any[]>({
        cacheTime: 60000,
        hash: (k) => JSON.stringify(k)
      });
      const invalidateRefs: Array<unknown> = [];

      function TestComponent() {
        const [tick, setTick] = useState(0);
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        const result = useResult(injectable);
        const invalidate = useInvalidate(injectable, cache);
        invalidateRefs.push(invalidate);

        useEffect(() => {
          injectable(1);
        }, [injectable]);

        return (
          <div>
            <span data-testid='result'>{result ?? 'no result'}</span>
            <button
              data-testid='invalidate'
              type='button'
              onClick={() => invalidate(1)}
            >
              invalidate
            </button>
            <button
              data-testid='rerender'
              type='button'
              onClick={() => setTick(tick + 1)}
            >
              rerender
            </button>
          </div>
        );
      }

      render(<TestComponent />);

      // first call populates the cache and the result
      await waitFor(() => {
        expect(resolveQueue.length).toBe(1);
      });
      await act(async () => {
        resolveQueue[0]('data 1 v1');
      });
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('data 1 v1');
      });
      expect(fetchData).toHaveBeenCalledTimes(1);
      expect(cache.get([1])).toEqual(['data 1 v1', expect.any(Number)]);

      // rerender: the invalidate reference stays stable
      await act(async () => {
        fireEvent.click(screen.getByTestId('rerender'));
      });
      expect(new Set(invalidateRefs).size).toBe(1);

      // invalidate deletes the entry before the call starts, so the second
      // call is a hard cache miss and fn runs again
      await act(async () => {
        fireEvent.click(screen.getByTestId('invalidate'));
      });
      await waitFor(() => {
        expect(fetchData).toHaveBeenCalledTimes(2);
      });
      expect(cache.get([1])).toBeUndefined();
      expect(fetchData).toHaveBeenLastCalledWith(1);

      // subscribers see the fresh result once the new call resolves
      await act(async () => {
        resolveQueue[1]('data 1 v2');
      });
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('data 1 v2');
      });
      expect(cache.get([1])).toEqual(['data 1 v2', expect.any(Number)]);
    });

    it('should only delete the cache entry for the given args', async () => {
      const resolveQueue: Array<(v: string) => void> = [];
      const fetchData = vi.fn(
        (id: number) =>
          new Promise<string>((resolve) => {
            resolveQueue.push(resolve);
          })
      );
      const cache = createMemoryCacheProvider<string, any[]>({
        cacheTime: 60000,
        hash: (k) => JSON.stringify(k)
      });

      cache.set([1], 'one');
      cache.set([2], 'two');

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        const invalidate = useInvalidate(injectable, cache);

        return (
          <button
            data-testid='invalidate'
            type='button'
            onClick={() => invalidate(1)}
          >
            invalidate
          </button>
        );
      }

      render(<TestComponent />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('invalidate'));
      });
      await waitFor(() => {
        expect(fetchData).toHaveBeenCalledTimes(1);
      });

      // only the [1] entry is gone and refetched; [2] survives untouched
      expect(cache.get([1])).toBeUndefined();
      expect(cache.get([2])).toEqual(['two', expect.any(Number)]);
      expect(fetchData).toHaveBeenCalledTimes(1);
      expect(fetchData).toHaveBeenCalledWith(1);
      expect(fetchData).not.toHaveBeenCalledWith(2);
    });
  });

  describe('invalidation', () => {
    // The composition every test below shares: the parent owns the
    // injectables (the library's cross-component model — state lives on
    // the functions you pass down), the Feed children cache + subscribe +
    // drive the query, the editors mutate and declare what to invalidate
    // with the literal option, so the `invalidates` types are checked
    // exactly as a user writes them.
    function Feed({
      query,
      cache,
      tab
    }: {
      query: (tab: string) => Promise<string>;
      cache: ReturnType<typeof createMemoryCacheProvider<string, any[]>>;
      tab: string;
    }) {
      useCache(query, cache, 60000);
      const result = useResult(query);
      useEffect(() => {
        void query(tab);
      }, [query, tab]);
      return <span data-testid={`feed-${tab}`}>{result ?? 'none'}</span>;
    }

    function SaveButton({mutate}: {mutate: (draft: string) => Promise<string>}) {
      return (
        <button
          data-testid='save'
          type='button'
          onClick={() => {
            mutate('draft').catch(() => {});
          }}
        >
          save
        </button>
      );
    }

    // By-identity target: every cache entry of the injectable.
    function IdentityEditor({
      query,
      save
    }: {
      query: (tab: string) => Promise<string>;
      save: (draft: string) => Promise<string>;
    }) {
      const [mutate] = useMutation(save, {invalidates: [query]});
      return <SaveButton mutate={mutate} />;
    }

    // Prefix target: only the entries whose args extend the prefix.
    function PrefixEditor({
      query,
      save
    }: {
      query: (tab: string) => Promise<string>;
      save: (draft: string) => Promise<string>;
    }) {
      const [mutate] = useMutation(save, {invalidates: [[query, 'news']]});
      return <SaveButton mutate={mutate} />;
    }

    function App({
      fetchFeed,
      save,
      cache,
      Editor
    }: {
      fetchFeed: (tab: string) => Promise<string>;
      save: (draft: string) => Promise<string>;
      cache: ReturnType<typeof createMemoryCacheProvider<string, any[]>>;
      Editor: typeof IdentityEditor | typeof PrefixEditor;
    }) {
      const query = useInjectable(fetchFeed);
      const write = useInjectable(save);
      return (
        <>
          <Feed query={query} cache={cache} tab='news' />
          <Editor query={query} save={write} />
        </>
      );
    }

    function deferredFetch() {
      const resolveQueue: Array<(v: string) => void> = [];
      const fetchFeed = vi.fn(
        (tab: string) =>
          new Promise<string>((resolve) => {
            resolveQueue.push(resolve);
          })
      );
      return {resolveQueue, fetchFeed};
    }

    it('should purge the cache and refetch what subscribers display when the mutation succeeds', async () => {
      const {resolveQueue, fetchFeed} = deferredFetch();
      const save = vi.fn(() => Promise.resolve('saved'));
      const cache = createMemoryCacheProvider<string, any[]>({
        cacheTime: 60000
      });

      render(
        <App
          fetchFeed={fetchFeed}
          save={save}
          cache={cache}
          Editor={IdentityEditor}
        />
      );

      // first call populates the cache and the result
      await waitFor(() => {
        expect(resolveQueue.length).toBe(1);
      });
      await act(async () => {
        resolveQueue[0]('feed v1');
      });
      await waitFor(() => {
        expect(screen.getByTestId('feed-news').textContent).toBe('feed v1');
      });
      expect(fetchFeed).toHaveBeenCalledTimes(1);
      expect(cache.get(['news'])).toEqual(['feed v1', expect.any(Number)]);

      // a successful mutation purges the entry and re-runs the tracked
      // ['news'] call — the subscriber goes through a fresh loading cycle
      await act(async () => {
        fireEvent.click(screen.getByTestId('save'));
      });
      await waitFor(() => {
        expect(fetchFeed).toHaveBeenCalledTimes(2);
      });
      expect(fetchFeed).toHaveBeenLastCalledWith('news');
      // the entry is deleted before the refetch starts, so the refetch is
      // a hard cache miss
      expect(cache.get(['news'])).toBeUndefined();

      await act(async () => {
        resolveQueue[1]('feed v2');
      });
      await waitFor(() => {
        expect(screen.getByTestId('feed-news').textContent).toBe('feed v2');
      });
      expect(cache.get(['news'])).toEqual(['feed v2', expect.any(Number)]);
      expect(save).toHaveBeenCalledWith('draft');
    });

    it('should invalidate nothing when the mutation fails', async () => {
      const {resolveQueue, fetchFeed} = deferredFetch();
      const save = vi.fn(() => Promise.reject(new Error('boom')));
      const cache = createMemoryCacheProvider<string, any[]>({
        cacheTime: 60000
      });

      render(
        <App
          fetchFeed={fetchFeed}
          save={save}
          cache={cache}
          Editor={IdentityEditor}
        />
      );

      await waitFor(() => {
        expect(resolveQueue.length).toBe(1);
      });
      await act(async () => {
        resolveQueue[0]('feed v1');
      });
      await waitFor(() => {
        expect(screen.getByTestId('feed-news').textContent).toBe('feed v1');
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('save'));
      });
      await act(async () => {});
      // the rejection left the cache and the displayed data untouched
      expect(fetchFeed).toHaveBeenCalledTimes(1);
      expect(cache.get(['news'])).toEqual(['feed v1', expect.any(Number)]);
      expect(screen.getByTestId('feed-news').textContent).toBe('feed v1');
    });

    it('should match targets by args prefix and leave other entries alone', async () => {
      const {resolveQueue, fetchFeed} = deferredFetch();
      const save = vi.fn(() => Promise.resolve('saved'));
      const cache = createMemoryCacheProvider<string, any[]>({
        cacheTime: 60000
      });

      // Two tabs are two injectables of the same fetcher (each owns its
      // result broadcast) sharing ONE cache provider — the SWR-recipe
      // composition. The prefix target discriminates entries inside the
      // shared cache.
      function TwoTabs() {
        const newsQuery = useInjectable(fetchFeed);
        const sportsQuery = useInjectable(fetchFeed);
        const write = useInjectable(save);
        return (
          <>
            <Feed query={newsQuery} cache={cache} tab='news' />
            <Feed query={sportsQuery} cache={cache} tab='sports' />
            <PrefixEditor query={newsQuery} save={write} />
          </>
        );
      }

      render(<TwoTabs />);

      // both tabs load once and land in the shared cache under their args
      await waitFor(() => {
        expect(resolveQueue.length).toBe(2);
      });
      await act(async () => {
        resolveQueue[0]('news v1');
        resolveQueue[1]('sports v1');
      });
      await waitFor(() => {
        expect(screen.getByTestId('feed-news').textContent).toBe('news v1');
        expect(screen.getByTestId('feed-sports').textContent).toBe(
          'sports v1'
        );
      });
      expect(cache.get(['news'])).toEqual(['news v1', expect.any(Number)]);
      expect(cache.get(['sports'])).toEqual(['sports v1', expect.any(Number)]);

      await act(async () => {
        fireEvent.click(screen.getByTestId('save'));
      });
      // only the 'news' line is invalidated and re-run
      await waitFor(() => {
        expect(fetchFeed).toHaveBeenCalledTimes(3);
      });
      expect(fetchFeed).toHaveBeenLastCalledWith('news');
      expect(cache.get(['news'])).toBeUndefined();
      expect(cache.get(['sports'])).toEqual(['sports v1', expect.any(Number)]);

      await act(async () => {
        resolveQueue[2]('news v2');
      });
      await waitFor(() => {
        expect(screen.getByTestId('feed-news').textContent).toBe('news v2');
      });
      expect(screen.getByTestId('feed-sports').textContent).toBe('sports v1');
    });

    it('should survive StrictMode double mounting with exactly one refetch', async () => {
      const {resolveQueue, fetchFeed} = deferredFetch();
      const save = vi.fn(() => Promise.resolve('saved'));
      const cache = createMemoryCacheProvider<string, any[]>({
        cacheTime: 60000
      });

      function StrictApp() {
        const query = useInjectable(fetchFeed);
        const write = useInjectable(save);
        return (
          <>
            <Feed query={query} cache={cache} tab='news' />
            <IdentityEditor query={query} save={write} />
          </>
        );
      }

      render(
        <StrictMode>
          <StrictApp />
        </StrictMode>
      );

      // StrictMode double-fires the mount effects: the initial run happens
      // twice (both cache misses until the first resolves)
      await waitFor(() => {
        expect(resolveQueue.length).toBe(2);
      });
      await act(async () => {
        resolveQueue[0]('feed v1');
        resolveQueue[1]('feed v1');
      });
      await waitFor(() => {
        expect(screen.getByTestId('feed-news').textContent).toBe('feed v1');
      });
      expect(cache.get(['news'])).toEqual(['feed v1', expect.any(Number)]);

      await act(async () => {
        fireEvent.click(screen.getByTestId('save'));
      });
      // the simulated remount re-tracked ['news'], so invalidation
      // refetches it exactly once (deduped by the structural key)
      await waitFor(() => {
        expect(fetchFeed).toHaveBeenCalledTimes(3);
      });
      expect(fetchFeed).toHaveBeenLastCalledWith('news');

      await act(async () => {
        resolveQueue[2]('feed v2');
      });
      await waitFor(() => {
        expect(screen.getByTestId('feed-news').textContent).toBe('feed v2');
      });
      expect(cache.get(['news'])).toEqual(['feed v2', expect.any(Number)]);
    });

    it('should purge a target without live consumers and not refetch it', async () => {
      const {resolveQueue, fetchFeed} = deferredFetch();
      const cache = createMemoryCacheProvider<string, any[]>({
        cacheTime: 60000
      });

      let queryRef: ((tab: string) => Promise<string>) | undefined;

      function OnlyFeed() {
        const query = useInjectable(fetchFeed);
        queryRef = query;
        return <Feed query={query} cache={cache} tab='news' />;
      }

      const {unmount} = render(<OnlyFeed />);

      await waitFor(() => {
        expect(resolveQueue.length).toBe(1);
      });
      await act(async () => {
        resolveQueue[0]('feed v1');
      });
      await waitFor(() => {
        expect(screen.getByTestId('feed-news').textContent).toBe('feed v1');
      });
      expect(cache.get(['news'])).toEqual(['feed v1', expect.any(Number)]);

      // the provider binding outlives the consumer: after unmount the
      // entry survives (that is what a cache is for) …
      unmount();
      expect(cache.get(['news'])).toEqual(['feed v1', expect.any(Number)]);

      // … and the standalone invalidate() still purges it, without a
      // refetch — there is no mounted wrapper chain to revalidate through
      act(() => {
        invalidate([queryRef!]);
      });
      expect(cache.get(['news'])).toBeUndefined();
      expect(fetchFeed).toHaveBeenCalledTimes(1);
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

  describe('useDedup', () => {
    it('should execute the underlying fn once for concurrent calls with the same args and share the same result', async () => {
      const data = {users: []};
      let resolveFn!: (v: typeof data) => void;
      const fetchData = vi.fn(
        () =>
          new Promise<typeof data>((resolve) => {
            resolveFn = resolve;
          })
      );

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useDedup(injectable);
        const [a, setA] = useState<typeof data>();
        const [b, setB] = useState<typeof data>();

        useEffect(() => {
          injectable(1).then(setA);
          injectable(1).then(setB);
        }, [injectable]);

        return (
          <div>
            <span data-testid='a'>{a ? 'done' : 'pending'}</span>
            <span data-testid='b'>{b ? 'done' : 'pending'}</span>
          </div>
        );
      }

      render(<TestComponent />);

      // Both calls fired while the promise was in flight
      await act(async () => {
        resolveFn(data);
      });
      await waitFor(() => {
        expect(screen.getByTestId('a').textContent).toBe('done');
        expect(screen.getByTestId('b').textContent).toBe('done');
      });

      expect(fetchData).toHaveBeenCalledTimes(1);
    });

    it('should re-run after settle and allow retrying a failed call', async () => {
      let fail = true;
      let resolveFn!: (v: string) => void;
      const fetchData = vi.fn(
        () =>
          new Promise<string>((resolve, reject) => {
            if (fail) reject(new Error('network down'));
            else resolveFn = resolve;
          })
      );

      let retry!: () => void;
      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useDedup(injectable);
        const [result, setResult] = useState<string | undefined>();

        const run = () => {
          injectable(1).then(setResult, () => setResult(undefined));
        };
        useEffect(run, [injectable]);
        retry = () => {
          fail = false;
          run();
        };

        return (
          <div>
            <span data-testid='result'>{result ?? 'no result'}</span>
            <button type='button' data-testid='retry' onClick={retry}>
              retry
            </button>
          </div>
        );
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('no result');
      });
      // First call failed and settled — it must not stay in the map
      expect(fetchData).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.click(screen.getByTestId('retry'));
      });
      // The retry re-executed the underlying fn
      expect(fetchData).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveFn!('ok');
      });
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('ok');
      });
    });

    it('should not dedupe calls with different args', async () => {
      const fetchData = vi.fn(async (id: number) => `result ${id}`);

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useDedup(injectable);
        const [results, setResults] = useState<string[]>([]);

        useEffect(() => {
          Promise.all([injectable(1), injectable(2)]).then((r) =>
            setResults(r)
          );
        }, [injectable]);

        return <div>{results.join(',')}</div>;
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByText('result 1,result 2')).toBeDefined();
      });
      expect(fetchData).toHaveBeenCalledTimes(2);
    });

    it('should dedupe button double clicks combined with useRun/useResult', async () => {
      const data = {value: 42};
      let resolveFn!: (v: typeof data) => void;
      const fetchData = vi.fn(
        () =>
          new Promise<typeof data>((resolve) => {
            resolveFn = resolve;
          })
      );

      function TestComponent() {
        const fetchValue = useInjectable(fetchData);
        useDedup(fetchValue);
        const value = useResult(fetchValue);

        return (
          <div>
            <span data-testid='value'>
              {value ? String(value.value) : 'none'}
            </span>
            <button
              type='button'
              data-testid='fetch'
              onClick={() => {
                void fetchValue();
                void fetchValue();
              }}
            >
              fetch
            </button>
          </div>
        );
      }

      render(<TestComponent />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('fetch'));
      });
      // A double click in the same tick shares one in-flight promise
      expect(fetchData).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveFn(data);
      });
      await waitFor(() => {
        expect(screen.getByTestId('value').textContent).toBe('42');
      });
    });

    it('should ignore the trailing AbortSignal when hashing args', async () => {
      const data = {value: 7};
      const signals: AbortSignal[] = [];
      let resolveFn!: (v: typeof data) => void;
      const fetchData = vi.fn(
        (signal: AbortSignal) =>
          new Promise<typeof data>((resolve) => {
            signals.push(signal);
            resolveFn = resolve;
          })
      );

      function Child({fetchValue}: {fetchValue: any}) {
        // Each useRun instance creates its own AbortController, so the two
        // children run with distinct signals but identical call arguments.
        useRun(fetchValue, [1], {signal: true});
        return null;
      }

      function TestComponent() {
        const fetchValue = useInjectable(fetchData);
        useDedup(fetchValue);
        const [extra, setExtra] = useState(false);
        return (
          <div>
            <Child fetchValue={fetchValue} />
            <Child fetchValue={fetchValue} />
            <button
              type='button'
              data-testid='add'
              onClick={() => setExtra(true)}
            >
              add
            </button>
            {extra && <Child fetchValue={fetchValue} />}
          </div>
        );
      }

      render(<TestComponent />);

      // Both children's runs are in flight concurrently with the same args:
      // they share one promise, so the fn runs once with one of the signals
      // while the other is aborted by cleanup after its shared run settles.
      await act(async () => {
        resolveFn(data);
      });
      await waitFor(() => {
        expect(fetchData).toHaveBeenCalledTimes(1);
      });
      expect(signals).toHaveLength(1);

      // After settling, the entry is gone — a later run executes again
      fireEvent.click(screen.getByTestId('add'));
      await waitFor(() => {
        expect(fetchData).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('usePolling', () => {
    it('should spread args into every tick', async () => {
      vi.useFakeTimers();
      try {
        const fetchUser = vi.fn(async (id: number) => `user ${id}`);
        function TestComponent() {
          const injectable = useInjectable(fetchUser);
          usePolling(injectable, 1000, {args: [42]});
          return null;
        }
        render(<TestComponent />);
        await vi.advanceTimersByTimeAsync(3000);
        expect(fetchUser).toHaveBeenCalledTimes(3);
        expect(fetchUser.mock.calls[0]).toEqual([42]);
        expect(fetchUser.mock.calls[2]).toEqual([42]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should re-arm the timer with the new args when an arg changes', async () => {
      vi.useFakeTimers();
      try {
        const fetchUser = vi.fn(async (id: number) => `user ${id}`);
        function TestComponent({id}: {id: number}) {
          const injectable = useInjectable(fetchUser);
          usePolling(injectable, 1000, {args: [id]});
          return null;
        }
        const {rerender} = render(<TestComponent id={1} />);
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetchUser).toHaveBeenCalledTimes(2);
        expect(fetchUser.mock.calls[1]).toEqual([1]);
        rerender(<TestComponent id={2} />);
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchUser).toHaveBeenCalledTimes(3);
        expect(fetchUser.mock.calls[2]).toEqual([2]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('useFocusRevalidate', () => {
    it('should spread args into the focus revalidation', () => {
      const fetchUser = vi.fn(async (id: number) => `user ${id}`);
      function TestComponent() {
        const injectable = useInjectable(fetchUser);
        useFocusRevalidate(injectable, {args: [42]});
        return null;
      }
      render(<TestComponent />);
      fireEvent(window, new Event('focus'));
      expect(fetchUser).toHaveBeenCalledTimes(1);
      expect(fetchUser.mock.calls[0]).toEqual([42]);
    });
  });

  describe('useSuspenseResult', () => {
    function SuspenseReader({fetchValue}: {fetchValue: () => Promise<string>}) {
      const data = useSuspenseResult(fetchValue);
      return <div>{data}</div>;
    }

    it('should suspend with the fallback until the first result resolves', async () => {
      let resolveFn!: (value: string) => void;
      const fetchData = vi.fn(
        () => new Promise<string>((resolve) => (resolveFn = resolve))
      );

      // StrictMode double-render on top: the hook order must stay stable
      // even though the suspended render throws after its hooks.
      function Owner() {
        const fetchValue = useInjectable(fetchData);
        // The driver sits outside the Suspense boundary: a subtree
        // suspended on its initial mount never commits, so its own
        // effects would never fire and the fetch would never start.
        useRun(fetchValue, []);
        return (
          <Suspense fallback={<div>loading…</div>}>
            <SuspenseReader fetchValue={fetchValue} />
          </Suspense>
        );
      }

      render(
        <StrictMode>
          <Owner />
        </StrictMode>
      );

      expect(screen.getByText('loading…')).toBeDefined();
      await act(async () => {
        resolveFn('first data');
      });
      expect(await screen.findByText('first data')).toBeDefined();
      expect(screen.queryByText('loading…')).toBeNull();
    });

    it('should update in place when a background refresh delivers a new result', async () => {
      let resolveFn!: (value: string) => void;
      const fetchData = vi.fn(
        () => new Promise<string>((resolve) => (resolveFn = resolve))
      );

      function Owner() {
        const fetchValue = useInjectable(fetchData);
        return (
          <>
            <button type='button' onClick={() => void fetchValue()}>
              refresh
            </button>
            <Suspense fallback={<div>loading…</div>}>
              <SuspenseReader fetchValue={fetchValue} />
            </Suspense>
          </>
        );
      }

      render(<Owner />);

      // Nothing is in flight while the reader renders, so it suspends on
      // the promise resolved by the first result published to the store.
      expect(screen.getByText('loading…')).toBeDefined();
      fireEvent.click(screen.getByText('refresh'));
      await act(async () => {
        resolveFn('v1');
      });
      expect(await screen.findByText('v1')).toBeDefined();
      expect(screen.queryByText('loading…')).toBeNull();

      // A background refresh keeps the old value on screen — no fallback
      // re-show — and swaps in the new result when it settles.
      fireEvent.click(screen.getByText('refresh'));
      expect(screen.getByText('v1')).toBeDefined();
      expect(screen.queryByText('loading…')).toBeNull();
      await act(async () => {
        resolveFn('v2');
      });
      expect(await screen.findByText('v2')).toBeDefined();
      expect(screen.queryByText('loading…')).toBeNull();
    });

    it('should suspend on the in-flight promise when the call already started', async () => {
      let resolveFn!: (value: string) => void;
      const fetchData = vi.fn(
        () => new Promise<string>((resolve) => (resolveFn = resolve))
      );

      // The wrapper that records the in-flight promise is registered by a
      // useSuspenseResult render, so the first reader mounts (and stays
      // suspended) before the call starts; the second reader then mounts
      // with the call in flight and must throw that very promise.
      function Owner() {
        const fetchValue = useInjectable(fetchData);
        const [phase, setPhase] = useState(0);
        return (
          <>
            <button type='button' onClick={() => setPhase(phase + 1)}>
              next
            </button>
            {phase >= 1 && (
              <Suspense fallback={<div>first loading…</div>}>
                <SuspenseReader fetchValue={fetchValue} />
              </Suspense>
            )}
            {phase >= 2 && (
              <button type='button' onClick={() => void fetchValue()}>
                start
              </button>
            )}
            {phase >= 3 && (
              <Suspense fallback={<div>second loading…</div>}>
                <SuspenseReader fetchValue={fetchValue} />
              </Suspense>
            )}
          </>
        );
      }

      render(<Owner />);

      // Phase 1: the reader suspends with nothing in flight (wake path).
      fireEvent.click(screen.getByText('next'));
      expect(screen.getByText('first loading…')).toBeDefined();

      // Phase 2: start the call, phase 3 mounts the second reader while
      // the promise is pending — it suspends on the in-flight promise.
      fireEvent.click(screen.getByText('next'));
      fireEvent.click(screen.getByText('start'));
      fireEvent.click(screen.getByText('next'));
      expect(screen.getByText('first loading…')).toBeDefined();
      expect(screen.getByText('second loading…')).toBeDefined();

      await act(async () => {
        resolveFn('started earlier');
      });
      // Both readers unsuspend on the same shared result.
      expect(await screen.findAllByText('started earlier')).toHaveLength(2);
      expect(screen.queryByText('first loading…')).toBeNull();
      expect(screen.queryByText('second loading…')).toBeNull();
    });
  });

  describe('keepPreviousData', () => {
    it('should keep the previous page on screen while the next one loads', async () => {
      let resolvePage2!: (v: string) => void;
      const fetchPage = vi.fn((page: number) =>
        page === 1
          ? Promise.resolve('page 1')
          : new Promise<string>((resolve) => (resolvePage2 = resolve))
      );

      function TestComponent({page}: {page: number}) {
        const loadPage = useInjectable(fetchPage);
        useRun(loadPage, [page]);
        const data = useResult(loadPage);
        const loading = useLoading(loadPage);
        const initialLoading = useInitialLoading(loadPage);
        return (
          <div>
            <span data-testid='result'>{data ?? 'no result'}</span>
            <span data-testid='loading'>{loading ? 'loading' : 'idle'}</span>
            <span data-testid='initial'>
              {initialLoading ? 'initial' : 'settled'}
            </span>
          </div>
        );
      }

      const {rerender} = render(<TestComponent page={1} />);
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('page 1');
      });
      expect(screen.getByTestId('loading').textContent).toBe('idle');
      expect(screen.getByTestId('initial').textContent).toBe('settled');

      // page 1 → 2: the new call hangs forever until resolved, yet the old
      // page must stay on screen instead of flashing back to undefined.
      rerender(<TestComponent page={2} />);
      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('loading');
      });
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage).toHaveBeenLastCalledWith(2);
      expect(screen.getByTestId('result').textContent).toBe('page 1');
      // A result exists, so the pending call is a background one — no
      // full-screen initial loading again.
      expect(screen.getByTestId('initial').textContent).toBe('settled');

      // The new result lands and replaces the old one everywhere.
      await act(async () => {
        resolvePage2!('page 2');
      });
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('page 2');
      });
      expect(screen.getByTestId('loading').textContent).toBe('idle');
    });

    it('should broadcast the cached page instantly and refresh stale data in the background', async () => {
      let resolveRefetch!: (v: string) => void;
      const fetchPage = vi.fn((page: number) =>
        page === 1
          ? Promise.resolve('page 1')
          : new Promise<string>((resolve) => (resolveRefetch = resolve))
      );
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 60000
      });
      // A previously visited page 2 sits in the cache.
      cache.set([2], 'cached page 2');

      function TestComponent() {
        const [page, setPage] = useState(1);
        const loadPage = useInjectable(fetchPage);
        // staleTime 0: every cache hit revalidates in the background.
        useCache(loadPage, cache);
        useRun(loadPage, [page]);
        const data = useResult(loadPage);
        const initialLoading = useInitialLoading(loadPage);
        return (
          <div>
            <span data-testid='result'>{data ?? 'no result'}</span>
            <span data-testid='initial'>
              {initialLoading ? 'initial' : 'settled'}
            </span>
            <button
              data-testid='next'
              type='button'
              onClick={() => setPage(page + 1)}
            >
              next
            </button>
          </div>
        );
      }

      render(<TestComponent />);
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('page 1');
      });

      // page 1 → 2 hits the cache: the cached value is broadcast at once —
      // no loading flash, the background refetch is already running.
      fireEvent.click(screen.getByTestId('next'));
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('cached page 2');
      });
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage).toHaveBeenLastCalledWith(2);
      expect(screen.getByTestId('initial').textContent).toBe('settled');

      // The background refresh lands and replaces the stale cache.
      await act(async () => {
        resolveRefetch!('page 2 fresh');
      });
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('page 2 fresh');
      });
    });
  });
});
