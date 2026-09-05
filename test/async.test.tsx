import {describe, it, expect, vi, beforeEach} from 'vitest';
import {render, screen, waitFor, act, fireEvent} from '@testing-library/react';
import {
  memo,
  StrictMode,
  Suspense,
  useCallback,
  useState,
  useEffect,
  startTransition
} from 'react';
import type {ComponentType, ReactNode} from 'react';
import {
  useRun,
  useInjectable,
  createMemoryCacheProvider,
  useResult,
  useResultSelect,
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
  useRefresh,
  useMutation,
  invalidate,
  getInjectContext,
  useInject,
  usePolling,
  useFocusRevalidate,
  useReconnectRevalidate,
  useArgsStatus,
  stableHash,
  isAbortSignal
} from '../src/async';
import type {ArgsStatus} from '../src/async';
import {trimTrailingSignal, useLoadingFn} from '../src/async/base';
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
      const fn = vi.fn((..._deps: number[]) => 'result');

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

    it('should re-request when switching args and again when switching back (no cacheProvider)', async () => {
      // The no-cache contract, pinned: without a cacheProvider there is no
      // memory between runs — every args change is a fresh request, and
      // returning to a previously fetched key fetches again instead of
      // serving the old result.
      const fetchUser = vi.fn(async (id: number) => `user ${id}`);

      function TestComponent({id}: {id: number}) {
        const injectable = useInjectable(fetchUser);
        useRun(injectable, [id]);
        const data = useResult(injectable);
        return <span>{data ?? 'none'}</span>;
      }

      const {rerender} = render(<TestComponent id={1} />);
      await waitFor(() => {
        expect(screen.getByText('user 1')).toBeDefined();
      });
      rerender(<TestComponent id={2} />);
      // The id=2 run takes the display only once its own result lands —
      // keep-previous-data shows 'user 1' until then.
      await waitFor(() => {
        expect(screen.getByText('user 2')).toBeDefined();
      });
      // Switching back is a THIRD request: nothing cached the first one.
      rerender(<TestComponent id={1} />);
      await waitFor(() => {
        expect(screen.getByText('user 1')).toBeDefined();
      });
      expect(fetchUser).toHaveBeenCalledTimes(3);
      expect(fetchUser).toHaveBeenNthCalledWith(1, 1);
      expect(fetchUser).toHaveBeenNthCalledWith(2, 2);
      expect(fetchUser).toHaveBeenNthCalledWith(3, 1);
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

    it('should keep every wrapper when sibling components inject the same injectable under StrictMode', async () => {
      const calls: string[] = [];
      let holder!: (...args: any[]) => Promise<any>;

      function Owner() {
        const f = useInjectable(async () => 'ok');
        holder = f;
        return (
          <>
            <First fn={f} />
            <Second fn={f} />
          </>
        );
      }

      function First({fn}: {fn: any}) {
        useInject(
          fn,
          (f: any) =>
            ((...args: any[]) => {
              calls.push('first');
              return f(...args);
            }) as any
        );
        return null;
      }

      function Second({fn}: {fn: any}) {
        useInject(
          fn,
          (f: any) =>
            ((...args: any[]) => {
              calls.push('second');
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
      // React 18's StrictMode replay leaves orphan trampolines behind, but
      // the cleanup must only drop those — each committed sibling keeps
      // exactly one wrapper, applied once per call. Second registered last,
      // so it is the outer layer and runs first.
      expect(calls).toEqual(['second', 'first']);
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

    it('should not extend the sweep deadline while extra consumers mount (line 45)', async () => {
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
      // the use()-channel sweep at t=1000 kept the entry — its clock was
      // reset by the t=500 read. The write channel's rescheduled scan runs
      // at t=1500 (1000ms after that read) and reaps the now-idle entry.
      // (No reads past this point: an access would refresh the GC clock.)
      let reaped = false;
      provider.subscribe!(() => {
        reaped = true;
      });
      vi.advanceTimersByTime(399); // t=1499: one ms before the scan
      expect(reaped).toBe(false);
      vi.advanceTimersByTime(2); // t=1501: the scan has fired
      await vi.waitFor(() => {
        expect(reaped).toBe(true);
      });
      expect(provider.snapshot!()).toEqual([]);

      vi.useRealTimers();
    });

    it('should reclaim per-entry after cacheTime once idle (lines 51-54)', async () => {
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
      // an access keeps the entry young — the GC clock refreshes on read
      expect(provider.get(['test'])).toBeDefined();

      vi.advanceTimersByTime(600);
      // the use()-channel sweep ran at t=1000, but the read at t=500 reset
      // the entry's clock, so it is still alive
      expect(provider.get(['test'])).toBeDefined();

      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => {
        expect(provider.get(['test'])).toBeUndefined();
      });

      vi.useRealTimers();
    });

    it('should reclaim from the re-armed use() timer after remount', async () => {
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
      // no access since the t=500 read; t=1000 sweep finds it 500ms idle
      expect(provider.get(['test'])).toBeDefined();

      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => {
        expect(provider.get(['test'])).toBeUndefined();
      });

      vi.useRealTimers();
    });

    it('should reclaim entries written with no consumer via the debounce sweep (router-loader channel)', async () => {
      vi.useFakeTimers();

      // 关键场景：路由 loader 直写缓存 —— 没有任何组件 use() 过这个 provider，
      // 旧「整表 GC」依赖 useCount 归零，这类条目永远不会被回收。
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 1000,
        hash: (key) => JSON.stringify(key)
      });

      const deleted: string[][] = [];
      provider.subscribe!((e) => {
        if (e.type === 'delete')
          deleted.push(...e.deleted.map((k) => k as string[]));
      });

      // loader 通道：不经 use()，直接 set + load
      provider.set(['loader-page'], 'primed');
      const pending = provider.load!(['loader-async'], async () => 'fetched');
      await pending;

      expect(provider.get(['loader-page'])).toBeDefined();
      expect(provider.get(['loader-async'])).toBeDefined();

      // 停在回收前一刻：set 通道的扫描挂在 t=1000（settle 又重置过一次）
      vi.advanceTimersByTime(999);
      expect(provider.snapshot!()).toHaveLength(2);

      vi.advanceTimersByTime(2);
      await vi.waitFor(() => {
        expect(provider.snapshot!()).toEqual([]);
      });
      // 逐条删除按契约携带被删条目的原始 args
      expect(deleted.sort()).toEqual([['loader-async'], ['loader-page']]);

      vi.useRealTimers();
    });

    it('should not reclaim an entry while its load is in flight', async () => {
      vi.useFakeTimers();

      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 1000,
        hash: (key) => JSON.stringify(key)
      });

      let resolveFn!: (v: string) => void;
      const pending = provider.load!(
        ['slow'],
        () => new Promise<string>((r) => (resolveFn = r))
      );
      vi.advanceTimersByTime(5000);

      // 请求仍在途：即便已远超 cacheTime，条目也不回收。
      // snapshot 契约是省略 in-flight-only 条目（无数据可展示），
      // 所以「未被回收」要用 delete 事件从未发生来证明。
      let deleted = false;
      provider.subscribe!((e) => {
        if (e.type === 'delete') deleted = true;
      });
      vi.advanceTimersByTime(5000);
      expect(deleted).toBe(false);
      expect(provider.peek!(['slow'])).toBeUndefined(); // 尚无 settled 数据

      resolveFn('done');
      await pending;
      // settle 后扫描通道重新计时；此刻数据刚落地，不会被回收
      expect(provider.get(['slow'])).toEqual(['done', expect.any(Number)]);

      vi.advanceTimersByTime(999);
      expect(provider.peek!(['slow'])).toBeDefined();
      vi.advanceTimersByTime(2);
      await vi.waitFor(() => {
        expect(provider.snapshot!()).toEqual([]);
      });

      vi.useRealTimers();
    });

    it('should never reclaim when cacheTime is Infinity', async () => {
      vi.useFakeTimers();

      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: Infinity,
        hash: (key) => JSON.stringify(key)
      });

      provider.set(['forever'], 'kept');
      await provider.load!(['forever-async'], async () => 'kept too');

      // 无消费者、长时间推进：没有任何回收通道被安排
      vi.advanceTimersByTime(1_000_000);
      expect(provider.get(['forever'])).toBeDefined();
      expect(provider.get(['forever-async'])).toBeDefined();
      expect(vi.getTimerCount()).toBe(0);

      vi.useRealTimers();
    });

    it('should default cacheTime to 5 minutes — idle entries are reclaimed (TanStack gcTime alignment)', async () => {
      vi.useFakeTimers();

      // No cacheTime given: the default must be a finite 5-minute idle
      // window, not Infinity — loader-primed entries nobody consumes must
      // not reside in memory forever by default.
      const provider = createMemoryCacheProvider<string, [string]>({
        hash: (key) => JSON.stringify(key)
      });

      provider.set(['default-gc'], 'primed');

      // One ms short of the window: still cached. (This read also refreshes
      // the entry's GC clock and slides the sweep deadline along with it.)
      vi.advanceTimersByTime(5 * 60_000 - 1);
      expect(provider.get(['default-gc'])).toBeDefined();

      // A full idle window after the last touch: the sweep reclaims it.
      vi.advanceTimersByTime(5 * 60_000 + 2);
      await vi.waitFor(() => {
        expect(provider.get(['default-gc'])).toBeUndefined();
      });

      vi.useRealTimers();
    });

    it('should carry the raw args of swept entries on the delete event', async () => {
      vi.useFakeTimers();

      const provider = createMemoryCacheProvider<
        {id: string},
        [string, number]
      >({
        cacheTime: 500,
        hash: (key) => JSON.stringify(key)
      });

      const events: Array<{type: string; deleted?: readonly unknown[]}> = [];
      provider.subscribe!((e) => events.push(e));

      provider.set(['alice', 1], {id: 'a1'});
      provider.set(['bob', 2], {id: 'b2'});
      // hydrate 条目没有原始 args，与 clear 行为一致：不进 deleted 列表
      provider.hydrate!({[`["carol",3]`]: [{id: 'c3'}, 42]});

      vi.advanceTimersByTime(501);
      await vi.waitFor(() => {
        expect(provider.snapshot!()).toEqual([]);
      });

      const deletes = events.filter((e) => e.type === 'delete');
      expect(deletes).toHaveLength(1);
      expect(deletes[0]!.deleted).toEqual([
        ['alice', 1],
        ['bob', 2]
      ]);

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

    it('should delete exactly the entry its snapshot row key addresses, even after in-place args mutation', async () => {
      const provider = createMemoryCacheProvider<string, any[]>();
      const args = [1];
      provider.set(args, 'v1');
      provider.set([2], 'v2');
      // set() stores the caller's array by reference; the caller mutates
      // it in place (a reused args buffer gaining an element) — re-hashing
      // delete(args) now lands on a different key and misses. The snapshot
      // row's key was recorded at write time and still addresses the entry.
      args.push(2);

      provider.deleteKey!(provider.snapshot!()![0]!.key);

      expect(await provider.get([1])).toBeUndefined();
      expect(provider.snapshot!()).toHaveLength(1);
      expect(provider.peek!([2])!.value).toBe('v2');
    });

    it('should fire one delete event per deleteKey hit and none on a miss', () => {
      const provider = createMemoryCacheProvider<string, [number]>();
      const events: unknown[] = [];
      provider.subscribe!((e) => events.push(e));
      provider.set([1], 'v1');
      provider.set([2], 'v2');

      provider.deleteKey!(stableHash([1]));
      // A key nothing ever wrote fires nothing — listeners only hear
      // real removals.
      provider.deleteKey!(stableHash([999]));

      expect(events).toEqual([
        {type: 'set'},
        {type: 'set'},
        {type: 'delete', deleted: [[1]]}
      ]);
      expect(provider.snapshot!().map((row) => row.value)).toEqual(['v2']);
    });

    it('should delete hydrated entries by key, reporting no raw tuple', () => {
      const provider = createMemoryCacheProvider<string, [number]>();
      const key = stableHash([1]);
      provider.hydrate!({[key]: ['v1', 0]});

      const events: {type: string; deleted?: unknown[]}[] = [];
      provider.subscribe!((e) => events.push(e as any));
      provider.deleteKey!(key);

      // Hydrated entries carry no raw args, so the deletion event lists
      // nothing — same shape delete() would report for them.
      expect(events).toEqual([{type: 'delete', deleted: []}]);
      expect(provider.snapshot!()).toEqual([]);
    });

    it('should not resurrect an entry deleteKey removed while its load was in flight', async () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });
      let resolveFn!: (v: string) => void;
      const promise = provider.load!(
        ['k'],
        () => new Promise<string>((resolve) => (resolveFn = resolve))
      );

      provider.deleteKey!(JSON.stringify(['k']));

      resolveFn('fetched');
      await promise;
      expect(await provider.get(['k'])).toBeUndefined();
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

    it('should run the factory once for concurrent loads with the same key', async () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });
      let resolveFn!: (v: string) => void;
      const factory = vi.fn(
        () => new Promise<string>((resolve) => (resolveFn = resolve))
      );

      const a = provider.load!(['k'], factory);
      const b = provider.load!(['k'], factory);
      resolveFn('v');

      expect(await a).toBe('v');
      expect(await b).toBe('v');
      expect(factory).toHaveBeenCalledTimes(1);
      expect(await provider.get(['k'])).toEqual(['v', expect.any(Number)]);
    });

    it('should stamp cachedAt from settlement, not from the request start', async () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });
      let factoryDoneAt = 0;
      const promise = provider.load!(
        ['k'],
        () =>
          new Promise<string>((resolve) => {
            setTimeout(() => {
              factoryDoneAt = Date.now();
              resolve('v');
            }, 10);
          })
      );

      await promise;

      // A slow response must not eat into the data's cacheTime budget: the
      // timestamp counts from when the value landed, which is never before
      // the factory finished.
      const [, cachedAt] = (await provider.get(['k']))!;
      expect(cachedAt).toBeGreaterThanOrEqual(factoryDoneAt);
    });

    it('should keep a write-through value when an in-flight load settles later', async () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });
      let resolveFn!: (v: string) => void;
      const promise = provider.load!(
        ['k'],
        () => new Promise<string>((resolve) => (resolveFn = resolve))
      );

      provider.set(['k'], 'written');

      resolveFn('fetched');
      // Callers of the shared request still receive its result…
      expect(await promise).toBe('fetched');
      // …but the cache keeps the value written while it was in flight.
      expect(await provider.get(['k'])).toEqual([
        'written',
        expect.any(Number)
      ]);
    });

    it('should not resurrect an entry deleted while its load was in flight', async () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });
      let resolveFn!: (v: string) => void;
      const promise = provider.load!(
        ['k'],
        () => new Promise<string>((resolve) => (resolveFn = resolve))
      );

      provider.delete(['k']);

      resolveFn('fetched');
      await promise;
      expect(await provider.get(['k'])).toBeUndefined();
    });

    it('should keep settled data and vacate the slot when a load rejects', async () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });
      provider.set(['k'], 'old');
      let rejectFn!: (e: Error) => void;
      const promise = provider.load!(
        ['k'],
        () => new Promise<string>((_, reject) => (rejectFn = reject))
      );

      rejectFn(new Error('boom'));

      await expect(promise).rejects.toThrow('boom');
      // SWR: a failed background refetch leaves the old value on screen.
      expect(await provider.get(['k'])).toEqual(['old', expect.any(Number)]);

      // The slot was vacated, so a retry starts a fresh factory instead of
      // sharing the rejected promise.
      const factory = vi.fn(() => Promise.resolve('fresh'));
      await provider.load!(['k'], factory);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(await provider.get(['k'])).toEqual(['fresh', expect.any(Number)]);
    });

    it('should peek settled entries without observing in-flight requests', async () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key)
      });
      let resolveFn!: (v: string) => void;
      const promise = provider.load!(
        ['k'],
        () => new Promise<string>((resolve) => (resolveFn = resolve))
      );

      expect(provider.peek!(['k'])).toBeUndefined();

      resolveFn('v');
      await promise;

      const peeked = provider.peek!(['k'])!;
      expect(peeked.value).toBe('v');
      expect(peeked.cachedAt).toEqual(expect.any(Number));
    });

    it('should mark snapshot rows pending while a load is in flight', async () => {
      const provider = createMemoryCacheProvider<string, [string]>();
      let resolveFn!: (v: string) => void;
      const promise = provider.load!(
        ['k'],
        () => new Promise<string>((resolve) => (resolveFn = resolve))
      );

      // an in-flight-only entry is invisible to snapshot()
      expect(provider.snapshot!()).toEqual([]);

      // a write-through set lands while the request is still pending
      provider.set(['k'], 'v1');
      const pending = provider.snapshot!();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        value: 'v1',
        cachedAt: expect.any(Number),
        pending: true
      });

      resolveFn('v2');
      await promise;
      // the generation bump from set() made the late settle a no-op
      const settled = provider.snapshot!();
      expect(settled).toHaveLength(1);
      expect(settled[0]!.value).toBe('v1');
      expect(settled[0]!.pending).toBeUndefined();
    });

    describe('patchWhere', () => {
      it('patches matching settled entries and returns what was written', () => {
        const provider = createMemoryCacheProvider<{n: number}, [string]>();
        provider.set(['a'], {n: 1});
        provider.set(['b'], {n: 2});
        provider.set(['c'], {n: 3});
        const written = provider.patchWhere!(
          (k) => k[0] !== 'c',
          (v) => ({n: v.n + 10})
        );
        expect(written).toEqual([
          {args: ['a'], prev: {n: 1}, next: {n: 11}},
          {args: ['b'], prev: {n: 2}, next: {n: 12}}
        ]);
        expect(provider.peek!(['a'])!.value).toEqual({n: 11});
        expect(provider.peek!(['c'])!.value).toEqual({n: 3});
      });

      it('skips void-returning updaters and fires one set event for the batch', () => {
        const provider = createMemoryCacheProvider<number, [string]>();
        provider.set(['a'], 1);
        provider.set(['b'], 2);
        const events: string[] = [];
        provider.subscribe!((e) => events.push(e.type));
        provider.patchWhere!(
          () => true,
          (v, k) => (k[0] === 'b' ? undefined : v + 1)
        );
        expect(provider.peek!(['a'])!.value).toBe(2);
        expect(provider.peek!(['b'])!.value).toBe(2);
        expect(events).toEqual(['set']);
      });

      it('bumps generation so a late in-flight settle cannot clobber the patch', async () => {
        const provider = createMemoryCacheProvider<string, [string]>();
        // A settled entry first — patchWhere addresses settled halves only;
        // a fresh-miss (inflight-only) entry is nothing visible to patch.
        provider.set(['a'], 'v1');
        let resolveFetch!: (v: string) => void;
        const promise = provider.load!(
          ['a'],
          () => new Promise<string>((r) => (resolveFetch = r))
        );
        provider.patchWhere!(
          () => true,
          () => 'patched'
        );
        resolveFetch!('late-server-value');
        await expect(promise).resolves.toBe('late-server-value');
        // The in-flight response predates the patch write; generation moved on.
        expect(provider.peek!(['a'])!.value).toBe('patched');
      });
    });

    describe('mutation', () => {
      it('runs update optimistically, applies the response, journals nothing on success', async () => {
        const provider = createMemoryCacheProvider<
          {favorited: boolean; count: number},
          [string]
        >();
        provider.set(['slug-1'], {favorited: false, count: 4});
        const favorite = provider.mutation!((slug: string, on: boolean) => ({
          mutate: () => Promise.resolve({favorited: on, count: 5}),
          key: [slug],
          update: (old) => ({...old, favorited: on}),
          apply: (old, resp) => ({
            ...old,
            favorited: resp.favorited,
            count: resp.count
          })
        }));
        const p = favorite('slug-1', true);
        // Optimistic step landed before the call resolved
        expect(provider.peek!(['slug-1'])!.value).toEqual({
          favorited: true,
          count: 4
        });
        await expect(p).resolves.toEqual({favorited: true, count: 5});
        expect(provider.peek!(['slug-1'])!.value).toEqual({
          favorited: true,
          count: 5
        });
      });

      it('rolls back to prev on failure, keeps the rejection traveling', async () => {
        const provider = createMemoryCacheProvider<
          {favorited: boolean},
          [string]
        >();
        provider.set(['slug-1'], {favorited: false});
        const favorite = provider.mutation!((slug: string, on: boolean) => ({
          mutate: () => Promise.reject(new Error('offline')),
          key: [slug],
          update: (old) => ({...old, favorited: on})
        }));
        await expect(favorite('slug-1', true)).rejects.toThrow('offline');
        expect(provider.peek!(['slug-1'])!.value).toEqual({favorited: false});
      });

      it('skips entries without a baseline (never fabricates), still runs the call', async () => {
        const provider = createMemoryCacheProvider<{n: number}, [string]>();
        const mutate = vi.fn(() => Promise.resolve({n: 1}));
        const run = provider.mutation!((slug: string) => ({
          mutate,
          key: [slug],
          update: (old) => ({...old, n: 99})
        }));
        await run('ghost');
        expect(mutate).toHaveBeenCalledTimes(1);
        expect(provider.peek!(['ghost'])).toBeUndefined();
      });

      it('omitted key patches every settled entry (projection across pages)', async () => {
        const provider = createMemoryCacheProvider<
          {articles: {slug: string; favorited: boolean}[]},
          [{offset: number}]
        >();
        provider.set([{offset: 0}], {
          articles: [{slug: 'a', favorited: false}]
        });
        provider.set([{offset: 10}], {
          articles: [
            {slug: 'b', favorited: true},
            {slug: 'a', favorited: false}
          ]
        });
        const patchOne = (
          page: {articles: {slug: string; favorited: boolean}[]},
          slug: string
        ) => ({
          articles: page.articles.map((x) =>
            x.slug === slug ? {...x, favorited: !x.favorited} : x
          )
        });
        const favorite = provider.mutation!((slug: string) => ({
          mutate: () => Promise.resolve({slug, favorited: true}),
          update: (page, slug) => patchOne(page, slug),
          // field-selecting from the response, not toggling again — the
          // optimistic toggle already ran
          apply: (page, resp, slug) => ({
            articles: page.articles.map((x) =>
              x.slug === slug ? {...x, favorited: resp.favorited} : x
            )
          })
        }));
        await favorite('a');
        expect(provider.peek!([{offset: 0}])!.value.articles[0]).toEqual({
          slug: 'a',
          favorited: true
        });
        expect(provider.peek!([{offset: 10}])!.value.articles[0]).toEqual({
          slug: 'b',
          favorited: true
        });
      });

      it('rejection unwinds every composed layer (nested mutations)', async () => {
        const article = createMemoryCacheProvider<
          {favorited: boolean},
          [string]
        >();
        const home = createMemoryCacheProvider<
          {articles: {slug: string; favorited: boolean}[]},
          [{offset: number}]
        >();
        article.set(['a'], {favorited: false});
        home.set([{offset: 0}], {articles: [{slug: 'a', favorited: false}]});
        const favoriteOnArticle = article.mutation!(
          (slug: string, on: boolean) => ({
            mutate: () => Promise.reject(new Error('offline')),
            key: [slug],
            update: (old) => ({...old, favorited: on})
          })
        );
        const favoriteOnHome = home.mutation!((slug: string, on: boolean) => ({
          mutate: () => favoriteOnArticle(slug, on),
          update: (page) => ({
            articles: page.articles.map((x) =>
              x.slug === slug ? {...x, favorited: on} : x
            )
          })
        }));
        await expect(favoriteOnHome('a', true)).rejects.toThrow('offline');
        expect(article.peek!(['a'])!.value).toEqual({favorited: false});
        expect(home.peek!([{offset: 0}])!.value.articles[0]).toEqual({
          slug: 'a',
          favorited: false
        });
      });

      it('apply receives the current value at settle time (concurrent write survives)', async () => {
        const provider = createMemoryCacheProvider<
          {favorited: boolean; following: boolean},
          [string]
        >();
        provider.set(['a'], {favorited: false, following: false});
        let resolveMutate!: (v: {favorited: boolean}) => void;
        const favorite = provider.mutation!((slug: string, on: boolean) => ({
          mutate: () =>
            new Promise<{favorited: boolean}>((r) => (resolveMutate = r)),
          key: [slug],
          update: (old) => ({...old, favorited: on}),
          apply: (old, resp) => ({...old, favorited: resp.favorited})
        }));
        const p = favorite('a', true);
        // While the request is in flight another writer patches `following`
        provider.set(['a'], {favorited: true, following: true});
        resolveMutate!({favorited: true});
        await p;
        // Field-selecting apply keeps the concurrent write; the journal's
        // rollback is not involved on success
        expect(provider.peek!(['a'])!.value).toEqual({
          favorited: true,
          following: true
        });
      });

      it('rollback does not clobber a concurrent writer (identity guard)', async () => {
        const provider = createMemoryCacheProvider<
          {favorited: boolean},
          [string]
        >();
        provider.set(['a'], {favorited: false});
        let rejectMutate!: (e: Error) => void;
        const favorite = provider.mutation!((slug: string, on: boolean) => ({
          mutate: () =>
            new Promise<{favorited: boolean}>((_, rej) => (rejectMutate = rej)),
          key: [slug],
          update: (old) => ({...old, favorited: on})
        }));
        const p = favorite('a', true);
        // A newer writer replaces our optimistic value while we are in flight
        provider.set(['a'], {favorited: true});
        rejectMutate!(new Error('offline'));
        await expect(p).rejects.toThrow('offline');
        // The newer writer's value survives our rollback
        expect(provider.peek!(['a'])!.value).toEqual({favorited: true});
      });
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
      // deduplicated because Set#add is idempotent, and the second effect
      // run JOINS the first run's in-flight request (useRun's concurrent
      // same-args sharing), so the fetch fires exactly once
      const {rerender} = render(
        <StrictMode>
          <TestComponent showThird={false} />
        </StrictMode>
      );
      expect(fetchData).toHaveBeenCalledTimes(1);
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
      expect(fetchData).toHaveBeenCalledTimes(1);
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

    it('should project the result through select', async () => {
      const fetchPage = vi.fn(async () => ({
        articles: ['a', 'b'],
        articlesCount: 2
      }));

      function TestComponent() {
        const injectable = useInjectable(fetchPage);
        // A select building a fresh object per call — the shape that would
        // break a naive useSyncExternalStore wiring.
        const count = useResultSelect(injectable, (r) => ({
          count: r.articlesCount
        }));
        useRun(injectable, []);
        return <div>{count === undefined ? 'loading' : count.count}</div>;
      }

      render(<TestComponent />);
      expect(screen.getByText('loading')).toBeDefined();
      await waitFor(() => {
        expect(screen.getByText('2')).toBeDefined();
      });
    });

    it('should neither re-run select nor change its reference on unrelated re-renders', async () => {
      const fetchPage = vi.fn(async () => ({articlesCount: 2}));
      const select = vi.fn((r: {articlesCount: number}) => ({
        count: r.articlesCount
      }));
      const renders = {projection: 0};

      const Projection = memo(({value}: {value?: {count: number}}) => {
        renders.projection++;
        return <span data-testid='projection'>{value?.count ?? 'none'}</span>;
      });

      function TestComponent() {
        const injectable = useInjectable(fetchPage);
        const [, setState] = useState(0);
        const count = useResultSelect(injectable, select);
        useRun(injectable, []);
        return (
          <div>
            <button type='button' onClick={() => setState((n) => n + 1)}>
              bump
            </button>
            <Projection value={count} />
          </div>
        );
      }

      render(<TestComponent />);
      await waitFor(() => {
        expect(screen.getByTestId('projection').textContent).toBe('2');
      });
      // The store never had a real input before the result landed, so the
      // projection ran exactly once — for the result itself.
      expect(select).toHaveBeenCalledTimes(1);
      const rendersAfterResult = renders.projection;

      // Two unrelated re-renders: the projection is neither recomputed nor
      // replaced by a fresh reference, so the memoized child stays skipped.
      fireEvent.click(screen.getByText('bump'));
      fireEvent.click(screen.getByText('bump'));
      expect(select).toHaveBeenCalledTimes(1);
      expect(renders.projection).toBe(rendersAfterResult);
      expect(screen.getByTestId('projection').textContent).toBe('2');
    });

    it('should recompute the projection when a new result arrives', async () => {
      const fetchPage = vi
        .fn<() => Promise<{articlesCount: number}>>()
        .mockResolvedValueOnce({articlesCount: 2})
        .mockResolvedValueOnce({articlesCount: 5});

      function TestComponent() {
        const injectable = useInjectable(fetchPage);
        const count = useResultSelect(injectable, (r) => r.articlesCount);
        useRun(injectable, []);
        return (
          <div>
            <button type='button' onClick={() => injectable()}>
              refresh
            </button>
            {count ?? 'loading'}
          </div>
        );
      }

      render(<TestComponent />);
      expect(screen.getByText('loading')).toBeDefined();

      await waitFor(() => {
        expect(screen.getByText('2')).toBeDefined();
      });

      fireEvent.click(screen.getByText('refresh'));
      await waitFor(() => {
        expect(screen.getByText('5')).toBeDefined();
      });
    });

    it('should apply select to the init value before the first result', async () => {
      const fetchPage = vi.fn(
        () => new Promise<{articlesCount: number}>(() => {})
      );

      function TestComponent() {
        const injectable = useInjectable(fetchPage);
        const count = useResultSelect(injectable, (r) => r.articlesCount, {
          articlesCount: 7
        });
        useRun(injectable, []);
        return <div>{count}</div>;
      }

      render(<TestComponent />);
      expect(screen.getByText('7')).toBeDefined();
    });

    it('should not call select while no result exists', async () => {
      const fetchPage = vi.fn(() => new Promise<never>(() => {}));
      const select = vi.fn((r: {articlesCount: number}) => r.articlesCount);

      function TestComponent() {
        const injectable = useInjectable(fetchPage);
        const count = useResultSelect(injectable, select);
        useRun(injectable, []);
        return <div>{count === undefined ? 'loading' : String(count)}</div>;
      }

      render(<TestComponent />);
      expect(screen.getByText('loading')).toBeDefined();
      expect(select).not.toHaveBeenCalled();
    });

    it('should recompute when the selector identity changes', async () => {
      let resolve!: (v: {a: number; b: number}) => void;
      const fetchPage = vi.fn(
        () => new Promise<{a: number; b: number}>((r) => (resolve = r))
      );

      function TestComponent() {
        const injectable = useInjectable(fetchPage);
        const [pickB, setPickB] = useState(false);
        const select = useCallback(
          (r: {a: number; b: number}) => (pickB ? r.b : r.a),
          [pickB]
        );
        const value = useResultSelect(injectable, select);
        useRun(injectable, []);
        return (
          <div>
            <button type='button' onClick={() => setPickB(true)}>
              swap
            </button>
            <span data-testid='value'>{value ?? 'loading'}</span>
          </div>
        );
      }

      render(<TestComponent />);
      await act(async () => {
        resolve({a: 1, b: 2});
      });
      expect(screen.getByTestId('value').textContent).toBe('1');

      // The result is unchanged; only the selector identity did. The
      // memo keys on both, so the new projection wins.
      fireEvent.click(screen.getByText('swap'));
      await waitFor(() => {
        expect(screen.getByTestId('value').textContent).toBe('2');
      });
    });

    it('should keep the projected snapshot stable under StrictMode double-render', async () => {
      const fetchPage = vi.fn(async () => ({articlesCount: 2}));
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        function TestComponent() {
          const injectable = useInjectable(fetchPage);
          const count = useResultSelect(injectable, (r) => ({
            count: r.articlesCount
          }));
          useRun(injectable, []);
          return <div>{count === undefined ? 'loading' : count.count}</div>;
        }

        render(
          <StrictMode>
            <TestComponent />
          </StrictMode>
        );
        await waitFor(() => {
          expect(screen.getByText('2')).toBeDefined();
        });
        expect(
          errors.mock.calls.some((call) =>
            String(call[0]).includes('getSnapshot')
          )
        ).toBe(false);
      } finally {
        errors.mockRestore();
      }
    });

    it('should coexist with useResult on the same injectable', async () => {
      const fetchPage = vi.fn(async () => ({
        articles: ['a'],
        articlesCount: 1
      }));

      function TestComponent() {
        const injectable = useInjectable(fetchPage);
        const full = useResult(injectable);
        const count = useResultSelect(injectable, (r) => r.articlesCount);
        useRun(injectable, []);
        return (
          <div>
            <span data-testid='full'>
              {full === undefined ? 'loading' : full.articles.join(',')}
            </span>
            <span data-testid='count'>
              {count === undefined ? 'loading' : count}
            </span>
          </div>
        );
      }

      render(<TestComponent />);
      await waitFor(() => {
        expect(screen.getByTestId('full').textContent).toBe('a');
        expect(screen.getByTestId('count').textContent).toBe('1');
      });
    });

    it('should seed a late mounter from the store result, not from init', async () => {
      const fetchPage = vi.fn(async () => ({articlesCount: 2}));
      let injectable!: any;

      function First() {
        injectable = useInjectable(fetchPage);
        const count = useResultSelect(injectable, (r) => r.articlesCount);
        useRun(injectable, []);
        return <div>{count === undefined ? 'loading' : count}</div>;
      }

      render(<First />);
      await waitFor(() => {
        expect(screen.getByText('2')).toBeDefined();
      });

      // A consumer mounting AFTER a result exists: the lazy initializer
      // must take store.lastResult, never the init fallback.
      function Late() {
        const count = useResultSelect(injectable, (r) => r.articlesCount, {
          articlesCount: 99
        });
        return <div data-testid='late'>{count}</div>;
      }

      render(<Late />);
      expect(screen.getByTestId('late').textContent).toBe('2');
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

    it('useError mount should resolve undefined on failure while the error stays readable from state', async () => {
      const fetchData = vi.fn(async (): Promise<string> => {
        throw new Error('swallowed');
      });
      let injectableRef: (() => Promise<string | undefined>) | undefined;

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const error = useError<Error>(injectable);
        injectableRef = injectable;
        return <span>{error ? error.message : 'no error'}</span>;
      }

      render(<TestComponent />);

      // the call resolves undefined instead of rejecting — the painless
      // "errors as state" fallback: fire-and-forget callers never dangle
      let settled: unknown = 'pending';
      await act(async () => {
        void injectableRef!().then(
          (v) => {
            settled = v;
          },
          () => {
            settled = 'rejected';
          }
        );
      });
      await waitFor(() => {
        expect(settled).toBeUndefined();
      });
      // the failure still surfaces through the state hooks
      await waitFor(() => {
        expect(screen.getByText('swallowed')).toBeDefined();
      });
    });

    it('useError mount should swallow after the whole chain regardless of registration order — a later useCache never caches undefined', async () => {
      const fetchData = vi.fn(async (): Promise<string> => {
        throw new Error('chain order');
      });
      const cache = createMemoryCacheProvider<string, []>();

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        // worst order: the swallow opt-in registered BEFORE useCache
        useCache(injectable, cache);
        const error = useError<Error>(injectable);
        return (
          <div>
            <span>{error ? error.message : 'no error'}</span>
            <button type='button' onClick={() => void injectable()}>
              run
            </button>
          </div>
        );
      }

      render(<TestComponent />);
      await act(async () => {
        fireEvent.click(screen.getByText('run'));
      });
      await waitFor(() => {
        expect(screen.getByText('chain order')).toBeDefined();
      });

      // the cached layer saw the real rejection (the swallow is applied at
      // the call boundary, not at this hook's position), so nothing was
      // written: a retry runs the fetch again instead of hitting undefined
      expect(await cache.get([])).toBeUndefined();
      await act(async () => {
        fireEvent.click(screen.getByText('run'));
      });
      expect(fetchData).toHaveBeenCalledTimes(2);
    });

    it('useError mount should keep useRun-triggered failures rejection-free', async () => {
      const fetchData = vi.fn(async (): Promise<string> => {
        throw new Error('run failure');
      });
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown) => unhandled.push(e);
      process.on('unhandledRejection', onUnhandled);

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        const error = useError<Error>(injectable);
        useRun(injectable, []);
        return <span>{error ? error.message : 'no error'}</span>;
      }

      try {
        render(<TestComponent />);
        await waitFor(() => {
          expect(screen.getByText('run failure')).toBeDefined();
        });
        // give any would-be unhandled rejection a macrotask to surface
        await act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
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
      const fetchData = vi.fn(async (): Promise<string> => {
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

    it('should catch a rejection and hand the transformed value onwards', async () => {
      const fetchData = vi.fn(async (): Promise<string> => {
        throw new Error('original');
      });
      const catcher = vi.fn((e: Error) => `caught: ${e.message}`);
      let outcome: unknown;

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useCatch(injectable, catcher);
        useEffect(() => {
          // thru semantics: the catcher runs as an interceptor, and the
          // call still RESOLVES — with the original error object — so a
          // fire-and-forget caller never sees an unhandled rejection.
          injectable().then((v) => {
            outcome = v;
          });
        }, [injectable]);
        return <div>test</div>;
      }

      render(<TestComponent />);
      await waitFor(() => {
        expect(outcome).toBeInstanceOf(Error);
      });
      expect((outcome as Error).message).toBe('original');
      expect(catcher).toHaveBeenCalledWith(expect.any(Error));
      expect(catcher).toHaveBeenCalledTimes(1);
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

    it('should stop retrying after the driver aborts (unmount)', async () => {
      const fetchData = vi.fn(async () => {
        throw new Error('fail');
      });

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useRetry(injectable, {retries: 10, backoff: () => 20});
        useRun(injectable, [], {signal: true});
        return null;
      }

      const {unmount} = render(<TestComponent />);
      // Let at least one retry land before tearing down.
      await waitFor(
        () => {
          expect(fetchData.mock.calls.length).toBeGreaterThanOrEqual(2);
        },
        {timeout: 2000}
      );
      unmount();
      const countAtUnmount = fetchData.mock.calls.length;
      // Long enough for several 20ms backoffs to have fired pre-fix.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
      });
      expect(fetchData.mock.calls.length).toBe(countAtUnmount);
    });

    it('should stop retrying a dependency-changed call while its preset backoff sleep is armed', async () => {
      vi.useFakeTimers();
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const seen: string[] = [];
      const fetchData = vi.fn(async (id: string) => {
        seen.push(id);
        throw new Error('fail');
      });

      function TestComponent({id}: {id: string}) {
        const injectable = useInjectable(fetchData);
        // retries: 1 → at most 2 attempts per args; linear first delay is
        // 1000ms jittered by the mocked 0.5 → exactly 1000ms.
        useRetry(injectable, {retries: 1, backoff: 'linear'});
        useRun(injectable, [id], {signal: true});
        return null;
      }

      try {
        const {rerender} = render(<TestComponent id='a' />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(seen).toEqual(['a']);
        // Rerender mid-sleep: the old run's signal aborts synchronously,
        // so the armed 1000ms sleep belongs to a cancelled call now.
        rerender(<TestComponent id='b' />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(seen).toEqual(['a', 'b']);
        // Well past the original 1000ms sleep: the aborted 'a' loop must
        // never fire its second attempt, while 'b' runs its full budget
        // (b1 → backoff → b2 → exhausted).
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
        expect(seen).toEqual(['a', 'b', 'b']);
      } finally {
        random.mockRestore();
        vi.useRealTimers();
      }
    });

    it('should jitter preset backoff delays by ±25% (custom backoffs untouched)', async () => {
      vi.useFakeTimers();
      const random = vi.spyOn(Math, 'random');
      const fetchData = vi.fn(async () => {
        throw new Error('fail');
      });

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useRetry(injectable, {retries: 2, backoff: 'linear'});
        useRun(injectable, []);
        return null;
      }

      try {
        // random() → 0: linear first delay = 1000 · (0.75 + 0) = 750ms.
        random.mockReturnValue(0);
        render(<TestComponent />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(fetchData).toHaveBeenCalledTimes(1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(749);
        });
        expect(fetchData).toHaveBeenCalledTimes(1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
        expect(fetchData).toHaveBeenCalledTimes(2);
        // random() → 1: linear second delay = 2000 · (0.75 + 0.5) = 2500ms.
        random.mockReturnValue(1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2500);
        });
        expect(fetchData).toHaveBeenCalledTimes(3);
        // retries: 2 exhausted — no further attempts regardless of timers.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10000);
        });
        expect(fetchData).toHaveBeenCalledTimes(3);
      } finally {
        random.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe('useCache', () => {
    it('should be defined', () => {
      expect(useCache).toBeDefined();
    });

    it('should never GC an entry observed by a mounted useCache consumer (P1)', async () => {
      vi.useFakeTimers();

      const fetchData = vi.fn(async () => 'data');
      const cache = createMemoryCacheProvider<string, []>({cacheTime: 1000});

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        // staleTime 远大于 cacheTime：排除 stale 重验的干扰，
        // 唯一可能的 refetch 来源就是 GC 删除事件。
        useCache(injectable, cache, 60000);
        useRun(injectable, []);
        const result = useResult(injectable);
        return <span data-testid='result'>{result ?? 'none'}</span>;
      }

      render(<TestComponent />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(fetchData).toHaveBeenCalledTimes(1);

      // 闲置推进 5 个 cacheTime 周期：挂载观察者豁免 GC，
      // 条目必须原样存活，绝不出现「删除 → 被动重取」的循环。
      for (let period = 1; period <= 5; period++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(fetchData).toHaveBeenCalledTimes(1);
        expect(cache.snapshot!()).toHaveLength(1);
      }
      expect(screen.getByTestId('result').textContent).toBe('data');

      vi.useRealTimers();
    });

    it('should reclaim the entry after the useCache consumer unmounts (P1)', async () => {
      vi.useFakeTimers();

      const fetchData = vi.fn(async () => 'data');
      const cache = createMemoryCacheProvider<string, []>({cacheTime: 1000});

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        useRun(injectable, []);
        return <span data-testid='result'>{useResult(injectable)}</span>;
      }

      const {unmount} = render(<TestComponent />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(cache.snapshot!()).toHaveLength(1);

      // 卸载即解除观察：条目回到 GC 时钟，cacheTime 后被回收，
      // 且没有新的 fetch（消费者已离场，被动重验不会触发）。
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(cache.snapshot!()).toEqual([]);
      expect(fetchData).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('should keep a shared-key entry observed until the last consumer unmounts (P3)', async () => {
      vi.useFakeTimers();

      const fetchData = vi.fn(async (id: number) => `data ${id}`);
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 1000
      });

      function Consumer({id, tag}: {id: number; tag: string}) {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        useRun(injectable, [id]);
        return <span data-testid={`consumer-${tag}`}>{tag}</span>;
      }

      // 两个消费者观察同一个 key：观察按消费者计数，
      // 任一卸载都不解除豁免（对齐 TanStack 的观察者计数）。
      const first = render(<Consumer id={1} tag='a' />);
      render(<Consumer id={1} tag='b' />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(fetchData).toHaveBeenCalledTimes(1);

      first.unmount();
      // 卸载其一后闲置 2 个 cacheTime 周期：另一消费者仍在观察，
      // 零多余 fetch、条目原样存活。
      for (let period = 1; period <= 2; period++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(fetchData).toHaveBeenCalledTimes(1);
        expect(cache.snapshot!()).toHaveLength(1);
      }

      vi.useRealTimers();
    });

    it('should reclaim a shared-key entry after every consumer unmounts (P3)', async () => {
      vi.useFakeTimers();

      const fetchData = vi.fn(async (id: number) => `data ${id}`);
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 1000
      });

      function Consumer({id}: {id: number}) {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        useRun(injectable, [id]);
        return <span>x</span>;
      }

      const first = render(<Consumer id={1} />);
      const second = render(<Consumer id={1} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(cache.snapshot!()).toHaveLength(1);

      // 卸载其一：计数 2→1，条目仍豁免。
      first.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(cache.snapshot!()).toHaveLength(1);

      // 全部卸载：计数归零，cacheTime 内回收。
      second.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(cache.snapshot!()).toEqual([]);

      vi.useRealTimers();
    });

    it('should not let a mounted-but-never-called consumer strand loader-written entries (P3)', async () => {
      vi.useFakeTimers();

      const loaderFetch = vi.fn(async () => 'loader data');
      const cache = createMemoryCacheProvider<string, [string]>({
        cacheTime: 1000
      });

      function Idle() {
        const injectable = useInjectable(async () => 'never fetched');
        useCache(injectable, cache as never, 60000);
        return <span>idle</span>;
      }

      // 挂载一个从不调用 injectable 的消费者（空元组观察）
      render(<Idle />);

      // 路由 loader 直写一个与该消费者无关的条目
      cache.load!(['loader-page'], () => loaderFetch());
      await act(async () => {
        await Promise.resolve();
      });
      expect(cache.snapshot!()).toHaveLength(1);

      // 闲置推进 3 个 cacheTime 周期：空元组观察不得搁浅无关条目。
      for (let period = 1; period <= 3; period++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(cache.snapshot!()).toEqual([]);
      }
      expect(loaderFetch).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('should reclaim after StrictMode double effects and unmount (T3)', async () => {
      vi.useFakeTimers();

      const fetchData = vi.fn(async (id: number) => `data ${id}`);
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 1000
      });

      function Consumer({id}: {id: number}) {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        useRun(injectable, [id]);
        return <span>x</span>;
      }

      // StrictMode 双效应：观察 catch-up/cleanup 各跑两次，幂等配对必须保证
      // 卸载后计数归零、条目按时回收。
      const {unmount} = render(
        <StrictMode>
          <Consumer id={1} />
        </StrictMode>
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(cache.snapshot!()).toHaveLength(1);

      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(cache.snapshot!()).toEqual([]);

      vi.useRealTimers();
    });

    it('should reclaim after repeated same-key calls then unmount (T4)', async () => {
      vi.useFakeTimers();

      const fetchData = vi.fn(async (id: number) => `data ${id}`);
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 1000
      });

      function Consumer({id}: {id: number}) {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        useRun(injectable, [id]);
        return <span>x</span>;
      }

      // 同 key 多轮挂载（每轮 wrapper on 候选 +1）：幂等 on 保证计数不虚增，
      // 前一轮消费者仍在时条目存活，最后一个消费者卸载后按时回收。
      const first = render(<Consumer id={1} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      const second = render(<Consumer id={1} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5);
      });
      second.unmount();

      const third = render(<Consumer id={1} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5);
      });
      third.unmount();

      // first 仍挂载：条目必须豁免。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(fetchData).toHaveBeenCalledTimes(1);
      expect(cache.snapshot!()).toHaveLength(1);

      first.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(cache.snapshot!()).toEqual([]);

      vi.useRealTimers();
    });

    it('should reclaim after invalidate-driven refetches then unmount (T5)', async () => {
      vi.useFakeTimers();

      const fetchData = vi.fn(async (id: number) => `data ${id}`);
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 1000
      });

      let invalidateOne!: (id: number) => Promise<unknown>;
      function Consumer({id}: {id: number}) {
        const injectable = useInjectable(fetchData);
        invalidateOne = useInvalidate(injectable, cache);
        useCache(injectable, cache, 60000);
        useRun(injectable, [id]);
        return <span>x</span>;
      }

      const {unmount} = render(<Consumer id={1} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(fetchData).toHaveBeenCalledTimes(1);

      // 两轮硬失效重取：每次 delete+refetch 后条目重建（继承 key 计数），
      // 卸载后必须按时回收，不得残留永久豁免。
      await act(async () => {
        await invalidateOne(1);
      });
      await act(async () => {
        await invalidateOne(1);
      });
      expect(fetchData).toHaveBeenCalledTimes(3);
      expect(cache.get([1])).toEqual(['data 1', expect.any(Number)]);

      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(cache.snapshot!()).toEqual([]);

      vi.useRealTimers();
    });

    it('should reclaim when the trigger hook is declared before useCache (T6)', async () => {
      vi.useFakeTimers();

      const fetchData = vi.fn(async (id: number) => `data ${id}`);
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 1000
      });

      function Consumer({id}: {id: number}) {
        const injectable = useInjectable(fetchData);
        // 触发 hook 声明在 useCache 之前：首次调用发生在 catch-up
        // effect 运行前。wrapper 的幂等 on 必须是唯一计数点。
        useRun(injectable, [id]);
        useCache(injectable, cache, 60000);
        return <span>x</span>;
      }

      const {unmount} = render(<Consumer id={1} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(cache.snapshot!()).toHaveLength(1);

      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      // 无残留计数：条目按时回收。
      expect(cache.snapshot!()).toEqual([]);

      vi.useRealTimers();
    });

    it('should reclaim when a child calls while the parent holds useCache (T7)', async () => {
      vi.useFakeTimers();

      const fetchData = vi.fn(async (id: number) => `data ${id}`);
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 1000
      });

      function Child({id}: {id: number}) {
        const injectable = useInjectable(fetchData);
        // 子组件 effect 先于父组件 effect 运行：调用先于父的 catch-up。
        useEffect(() => {
          void injectable(id);
        }, [injectable, id]);
        return <span>x</span>;
      }

      function Parent({id}: {id: number}) {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        return <Child id={id} />;
      }

      const {unmount} = render(<Parent id={1} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(fetchData).toHaveBeenCalledTimes(1);

      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(cache.snapshot!()).toEqual([]);

      vi.useRealTimers();
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
      const cache = createMemoryCacheProvider<string, []>({
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
      const cache = createMemoryCacheProvider<string, []>({
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

    it("should keep stale verdicts per-key — purging one seen args never flags another key's display", async () => {
      const cache = createMemoryCacheProvider<string, [number]>();
      let calls = 0;
      const pending: Array<(v: string) => void> = [];
      const fetchUser = vi.fn((id: number) => {
        calls += 1;
        // The two useRun-driven calls resolve; every revalidation the
        // purges trigger below is held pending so the display cannot move
        // on its own.
        if (calls <= 2) return Promise.resolve(`user ${id}`);
        return new Promise<string>((resolve) => pending.push(resolve));
      });

      function TestComponent({id}: {id: number}) {
        const injectable = useInjectable(fetchUser);
        // Long staleTime: nothing goes stale on its own — only a purge can
        // raise a verdict.
        const isStale = useCache(injectable, cache, 60000);
        useRun(injectable, [id]);
        return <span data-testid='stale'>{isStale ? 'stale' : 'fresh'}</span>;
      }

      const {rerender} = render(<TestComponent id={1} />);
      await waitFor(() => expect(fetchUser).toHaveBeenCalledTimes(1));
      rerender(<TestComponent id={2} />);
      await waitFor(() => expect(fetchUser).toHaveBeenCalledTimes(2));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      // The display is [2]'s result, and it is fresh.
      expect(screen.getByTestId('stale').textContent).toBe('fresh');

      // Purge [1] — a key this consumer has SEEN, but not the one on
      // display. Its re-run is held pending. The old injectable-level
      // stale flag flipped every consumer here; the per-key verdict lands
      // on [1]'s slot and leaves [2]'s display untouched.
      await act(async () => {
        invalidate([[cache, 1]]);
      });
      expect(fetchUser).toHaveBeenCalledTimes(3); // [1] re-run, pending
      expect(screen.getByTestId('stale').textContent).toBe('fresh');

      // Purging the DISPLAYED key flags exactly that key…
      await act(async () => {
        invalidate([[cache, 2]]);
      });
      expect(fetchUser).toHaveBeenCalledTimes(4); // [2] re-run, pending
      await waitFor(() => {
        expect(screen.getByTestId('stale').textContent).toBe('stale');
      });

      // …and each verdict clears when its own re-run succeeds: [1]'s
      // success takes the display with a cleared verdict, while [2]'s
      // still-pending verdict lives only on its own slot.
      await act(async () => {
        pending[0]!('user 1 v2');
      });
      await waitFor(() => {
        expect(screen.getByTestId('stale').textContent).toBe('fresh');
      });
      await act(async () => {
        pending[1]!('user 2 v2');
      });
      await waitFor(() => {
        expect(screen.getByTestId('stale').textContent).toBe('fresh');
      });
    });

    it("should report each args tuple's own staleness verdict on interleaved cache hits", async () => {
      const cache = createMemoryCacheProvider<string, [number]>();
      // Every refetch hangs forever, so a stale verdict stays raised until
      // the test flips keys — exactly the window the assertions read.
      const fetchUser = vi.fn(
        (id: number) => new Promise<string>(() => {}) // never settles
      );
      cache.set([1], 'user 1 old');
      // Let [1] age past staleTime while [2] is written fresh.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
      cache.set([2], 'user 2 fresh');

      function TestComponent() {
        const injectable = useInjectable(fetchUser);
        const isStale = useCache(injectable, cache, 30);
        const data = useResult(injectable);
        return (
          <div>
            <span data-testid='data'>{data ?? 'no result'}</span>
            <span data-testid='stale'>{isStale ? 'stale' : 'fresh'}</span>
            <button
              data-testid='key-1'
              type='button'
              onClick={() => {
                injectable(1);
              }}
            >
              key 1
            </button>
            <button
              data-testid='key-2'
              type='button'
              onClick={() => {
                injectable(2);
              }}
            >
              key 2
            </button>
          </div>
        );
      }

      render(<TestComponent />);

      // Stale hit on [1]: cached data broadcast, [1]'s verdict raised.
      await act(async () => {
        fireEvent.click(screen.getByTestId('key-1'));
      });
      expect(screen.getByTestId('data').textContent).toBe('user 1 old');
      await waitFor(() => {
        expect(screen.getByTestId('stale').textContent).toBe('stale');
      });
      expect(fetchUser).toHaveBeenCalledTimes(1); // the hanging refetch

      // Fresh hit on [2]: display moves, and the flag follows the
      // DISPLAYED key — [1]'s raised verdict cannot leak into it.
      await act(async () => {
        fireEvent.click(screen.getByTestId('key-2'));
      });
      expect(screen.getByTestId('data').textContent).toBe('user 2 fresh');
      await waitFor(() => {
        expect(screen.getByTestId('stale').textContent).toBe('fresh');
      });
      expect(fetchUser).toHaveBeenCalledTimes(1); // no refetch: fresh

      // Back to [1]: its own verdict is raised again. The refetch joins
      // the still-pending request through the provider's in-flight `load`
      // slot (never-settling promise), so no second fetch leaves.
      await act(async () => {
        fireEvent.click(screen.getByTestId('key-1'));
      });
      expect(screen.getByTestId('data').textContent).toBe('user 1 old');
      await waitFor(() => {
        expect(screen.getByTestId('stale').textContent).toBe('stale');
      });
      expect(fetchUser).toHaveBeenCalledTimes(1);
    });

    it('should share one in-flight request across independent injectables using the same provider', async () => {
      let resolveFn!: (v: string) => void;
      const fetchData = vi.fn(
        () => new Promise<string>((resolve) => (resolveFn = resolve))
      );
      const cache = createMemoryCacheProvider<string, []>({
        cacheTime: 60000,
        hash: (k) => JSON.stringify(k)
      });

      // Two component instances → two independent injectables (separate
      // stores and broadcasts), but one shared provider: the provider-level
      // in-flight slot collapses their concurrent misses into one request —
      // deduplication is entirely the provider's job.
      function Consumer({label}: {label: string}) {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        const result = useResult(injectable);
        useRun(injectable, []);

        return <span data-testid={label}>{result ?? 'pending'}</span>;
      }

      function TestComponent() {
        return (
          <div>
            <Consumer label='a' />
            <Consumer label='b' />
          </div>
        );
      }

      render(<TestComponent />);

      // both consumers miss the cache in the same commit; the provider's
      // in-flight slot collapses the two misses into one request
      await waitFor(() => {
        expect(fetchData).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        resolveFn!('v1');
      });
      await waitFor(() => {
        expect(screen.getByTestId('a').textContent).toBe('v1');
        expect(screen.getByTestId('b').textContent).toBe('v1');
      });

      expect(fetchData).toHaveBeenCalledTimes(1);
    });

    it('should merge rapid clicks while a request is in flight through the provider load slot', async () => {
      const data = {value: 42};
      let resolveFn!: (v: typeof data) => void;
      const fetchData = vi.fn(
        () =>
          new Promise<typeof data>((resolve) => {
            resolveFn = resolve;
          })
      );
      const cache = createMemoryCacheProvider<typeof data, []>({
        cacheTime: 60000
      });

      function TestComponent() {
        const fetchValue = useInjectable(fetchData);
        useCache(fetchValue, cache);
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
      // A double click in the same tick shares one in-flight request — the
      // provider's load slot, not a separate dedup registry.
      expect(fetchData).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveFn(data);
      });
      await waitFor(() => {
        expect(screen.getByTestId('value').textContent).toBe('42');
      });
    });

    it('should work with a legacy provider that has no load() (write-through set)', async () => {
      const backing = new Map<string, [string, number]>();
      // The minimal pre-load() provider surface: get/set/delete/clear. No
      // load() (the routing layer calls through and write-through set()
      // applies the result) and no subscribe()/deleteWhere() members.
      const legacy = {
        get: (args: [number]) => backing.get(JSON.stringify(args)),
        set: (args: [number], value: string) =>
          void backing.set(JSON.stringify(args), [value, Date.now()]),
        delete: (args: [number]) => void backing.delete(JSON.stringify(args)),
        clear: () => backing.clear(),
        // useEffect(cacheProvider.use, []) runs on mount; a no-op keeps
        // the minimal provider compatible without idle expiry.
        use: () => () => {}
      };

      const fetchData = vi.fn(async (id: number) => `v:${id}`);

      function Consumer({label}: {label: string}) {
        const query = useInjectable(fetchData);
        useCache(query, legacy as any, 60000);
        const result = useResult(query);
        useEffect(() => {
          void query(1).catch(() => {});
        }, [query]);
        return <span data-testid={label}>{result ?? 'pending'}</span>;
      }

      const first = render(<Consumer label='a' />);
      await waitFor(() => {
        expect(screen.getByTestId('a').textContent).toBe('v:1');
      });
      // the legacy path wrote through to the provider itself
      expect(legacy.get([1])).toEqual(['v:1', expect.any(Number)]);
      expect(fetchData).toHaveBeenCalledTimes(1);

      // a remounted consumer hits the legacy cache and never refetches
      first.unmount();
      render(<Consumer label='b' />);
      await waitFor(() => {
        expect(screen.getByTestId('b').textContent).toBe('v:1');
      });
      expect(fetchData).toHaveBeenCalledTimes(1);
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
      const cache = createMemoryCacheProvider<string, [number]>({
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
      const cache = createMemoryCacheProvider<string, [number]>({
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

    it('useRefresh should delete the current args entry and force one fresh fetch', async () => {
      const fetchData = vi.fn(
        async (id: number) => `data ${id} v${fetchData.mock.calls.length}`
      );
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 60000
      });

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        const result = useResult(injectable);
        const refresh = useRefresh(injectable, [1], cache);
        useRun(injectable, [1]);
        return (
          <div>
            <span data-testid='result'>{result ?? 'no result'}</span>
            <button
              data-testid='refresh'
              type='button'
              onClick={() => void refresh()}
            >
              refresh
            </button>
          </div>
        );
      }

      render(<TestComponent />);
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('data 1 v1');
      });
      expect(fetchData).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.click(screen.getByTestId('refresh'));
      });
      // hard miss: the entry was deleted before the call, so the fetch runs
      // again — and exactly once (the revalidation-slot claim suppresses
      // the double fetch our own deletion event would trigger)
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('data 1 v2');
      });
      expect(fetchData).toHaveBeenCalledTimes(2);
      expect(cache.get([1])).toEqual(['data 1 v2', expect.any(Number)]);
    });

    it('useRefresh should hit the entry a useRun({signal: true}) rerun stored', async () => {
      const fetchData = vi.fn(
        async (id: number, signal: AbortSignal) =>
          `data ${id} ${signal.aborted ? 'aborted' : 'live'}`
      );
      // default hash: the run's [...args, signal] tuple and the plain args
      // tuple address DIFFERENT keys (stableHash collapses signals to a
      // placeholder but keeps the slot) — the dual-addressing case
      const cache = createMemoryCacheProvider<string, [number, AbortSignal]>({
        cacheTime: 60000
      });

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        const result = useResult(injectable);
        const refresh = useRefresh(injectable, [1], cache);
        useRun(injectable, [1], {signal: true});
        return (
          <div>
            <span data-testid='result'>{result ?? 'no result'}</span>
            <button
              data-testid='refresh'
              type='button'
              onClick={() => void refresh()}
            >
              refresh
            </button>
          </div>
        );
      }

      render(<TestComponent />);
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('data 1 live');
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('refresh'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('data 1 live');
        expect(fetchData).toHaveBeenCalledTimes(2);
      });
      // the run's signal-keyed entry is gone (hashed with any signal
      // instance it collapses to the same placeholder)…
      expect(
        await cache.get([1, new AbortController().signal])
      ).toBeUndefined();
      // …and the fresh write landed, so subscribers were re-broadcast
      expect(fetchData).toHaveBeenLastCalledWith(1);
    });

    // 场景复现（修复回归）：signal 剥离型自定义 hash 下，refresh 的第一
    // 个 delete（plain 元组）就命中 useRun({signal: true}) 写入的条目，
    // 删除事件在「两个 pending claim 只落了一半」的窗口内同步派发——
    // 事件携带条目的原始元组（尾带 signal，stableHash 归一为 #sig 孪生
    // key），该 key 尚未被 claim，消费者重跑与 refresh 自己的重取经
    // provider 的 in-flight 去重合并为一次 fetch、两趟 wrapper 链 settle：
    // 一次失败的 refetch 被 failureCount 双计（默认 hash 下第一个 delete
    // 打不中条目，事件只在两个 claim 都就位后才发，掩盖了该交错）。
    // 修复：所有 claim 先于任何 delete 落位（两阶段）。
    it('useRefresh with a signal-stripping hash: a failed refetch after a success tallies ONE failure', async () => {
      const stripSignalHash = (args: unknown[]): string =>
        stableHash(args.filter((a) => !isAbortSignal(a)));
      const fetchData = vi
        .fn<(id: number, signal: AbortSignal) => Promise<string[]>>()
        .mockResolvedValueOnce(['v1'])
        .mockRejectedValueOnce(new Error('boom'));
      const cache = createMemoryCacheProvider<string[], [number, AbortSignal]>({
        cacheTime: 60000,
        hash: stripSignalHash as any
      });

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        // 尾参 signal 会按读取侧契约剥除（trimTrailingSignal），key 与
        // [1] 等价——这里直接按 useRun({signal: true}) 追加后的真实形状传
        const status = useArgsStatus(injectable, [
          1,
          new AbortController().signal
        ]);
        const refresh = useRefresh(injectable, [1], cache);
        useRun(injectable, [1], {signal: true});
        return (
          <div>
            <span data-testid='result'>{status.data?.[0] ?? 'no result'}</span>
            <span data-testid='fc'>{status.failureCount}</span>
            <span data-testid='stamp'>{status.dataUpdatedAt ?? ''}</span>
            <button
              data-testid='refresh'
              type='button'
              onClick={() => void refresh()}
            >
              refresh
            </button>
          </div>
        );
      }

      render(<TestComponent />);
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('v1');
      });
      const stampBefore = screen.getByTestId('stamp').textContent;
      expect(stampBefore).not.toBe('');

      await act(async () => {
        fireEvent.click(screen.getByTestId('refresh'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('fc').textContent).toBe('1');
      });
      // one underlying fetch, ONE tallied failure — not two
      expect(fetchData).toHaveBeenCalledTimes(2);
      // the last success stays stamped across the failed refetch
      expect(screen.getByTestId('result').textContent).toBe('v1');
      expect(screen.getByTestId('stamp').textContent).toBe(stampBefore);
    });

    it('useRefresh should stay referentially stable and follow the newest args', async () => {
      const fetchData = vi.fn(async (id: number) => `data ${id}`);
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 60000
      });
      const refreshRefs: Array<() => Promise<string | undefined>> = [];

      function TestComponent({id}: {id: number}) {
        const [, setTick] = useState(0);
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        const result = useResult(injectable);
        const refresh = useRefresh(injectable, [id], cache);
        useRun(injectable, [id]);
        refreshRefs.push(refresh);
        return (
          <div>
            <span data-testid='result'>{result ?? 'no result'}</span>
            <button
              data-testid='rerender'
              type='button'
              onClick={() => setTick((t) => t + 1)}
            >
              rerender
            </button>
            <button
              data-testid='refresh'
              type='button'
              onClick={() => void refresh()}
            >
              refresh
            </button>
          </div>
        );
      }

      const {rerender} = render(<TestComponent id={1} />);
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('data 1');
      });

      // stable across re-renders…
      await act(async () => {
        fireEvent.click(screen.getByTestId('rerender'));
      });
      expect(new Set(refreshRefs).size).toBe(1);

      // …and across args changes: the SAME callback reference now
      // refreshes the newest args
      rerender(<TestComponent id={2} />);
      await waitFor(() => {
        expect(screen.getByTestId('result').textContent).toBe('data 2');
      });
      const captured = refreshRefs[refreshRefs.length - 1];
      expect(captured).toBe(refreshRefs[0]);
      await act(async () => {
        void captured();
      });
      await waitFor(() => {
        expect(fetchData).toHaveBeenLastCalledWith(2);
      });
      expect(fetchData).toHaveBeenCalledTimes(3);
    });

    it('useRefresh should bypass an in-flight provider request and never reject', async () => {
      const rejectQueue: Array<(e: Error) => void> = [];
      const fetchData = vi.fn(
        (id: number) =>
          new Promise<string>((resolve, reject) => {
            rejectQueue.push(reject);
          })
      );
      const cache = createMemoryCacheProvider<string, [number]>({
        cacheTime: 60000
      });
      let refreshFn: (() => Promise<string | undefined>) | undefined;

      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useCache(injectable, cache, 60000);
        const refresh = useRefresh(injectable, [1], cache);
        refreshFn = refresh;
        useEffect(() => {
          void injectable(1).catch(() => {});
        }, [injectable]);
        return null;
      }

      render(<TestComponent />);
      await waitFor(() => {
        expect(fetchData).toHaveBeenCalledTimes(1);
      });
      // the first request is still in flight in the provider's load slot

      // the returned promise never rejects — track it across a failure
      let settled: unknown = 'pending';
      await act(async () => {
        const p = refreshFn!();
        void p.then(
          (v) => {
            settled = v;
          },
          () => {
            settled = 'rejected';
          }
        );
      });
      // the entry was deleted with its in-flight load slot, so the refresh
      // started a SECOND request instead of joining the pending first one
      // (which it would share without the delete)
      await waitFor(() => {
        expect(fetchData).toHaveBeenCalledTimes(2);
      });

      // the refreshed request fails: the promise resolves undefined
      await act(async () => {
        rejectQueue[1]!(new Error('refresh failed'));
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(settled).toBeUndefined();
    });
  });

  describe('invalidation', () => {
    // The composition every test below shares: the Feed children cache +
    // subscribe + drive the query through their injectables, the editors
    // mutate and declare what to invalidate with the literal option, so
    // the `invalidates` types are checked exactly as a user writes them.
    // Note the editors never see the injectable — a provider reference
    // (usually a module constant) is all invalidation needs.
    function Feed({
      query,
      cache,
      tab
    }: {
      query: (tab: string) => Promise<string>;
      cache: ReturnType<typeof createMemoryCacheProvider<string, [string]>>;
      tab: string;
    }) {
      useCache(query, cache, 60000);
      const result = useResult(query);
      useEffect(() => {
        void query(tab);
      }, [query, tab]);
      return <span data-testid={`feed-${tab}`}>{result ?? 'none'}</span>;
    }

    function SaveButton({
      mutate
    }: {
      mutate: (draft: string) => Promise<string>;
    }) {
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

    // By-identity target: every entry of the provider.
    function IdentityEditor({
      cache,
      save
    }: {
      cache: ReturnType<typeof createMemoryCacheProvider<string, [string]>>;
      save: (draft: string) => Promise<string>;
    }) {
      const [mutate] = useMutation(save, {invalidates: [cache]});
      return <SaveButton mutate={mutate} />;
    }

    // Prefix target: only the entries whose args extend the prefix.
    function PrefixEditor({
      cache,
      save
    }: {
      cache: ReturnType<typeof createMemoryCacheProvider<string, [string]>>;
      save: (draft: string) => Promise<string>;
    }) {
      const [mutate] = useMutation(save, {invalidates: [[cache, 'news']]});
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
      cache: ReturnType<typeof createMemoryCacheProvider<string, [string]>>;
      Editor: typeof IdentityEditor | typeof PrefixEditor;
    }) {
      const query = useInjectable(fetchFeed);
      const write = useInjectable(save);
      return (
        <>
          <Feed query={query} cache={cache} tab='news' />
          <Editor cache={cache} save={write} />
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
      const cache = createMemoryCacheProvider<string, [string]>({
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
      const cache = createMemoryCacheProvider<string, [string]>({
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
      const cache = createMemoryCacheProvider<string, [string]>({
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
            <PrefixEditor cache={cache} save={write} />
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
        expect(screen.getByTestId('feed-sports').textContent).toBe('sports v1');
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
      const cache = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000
      });

      function StrictApp() {
        const query = useInjectable(fetchFeed);
        const write = useInjectable(save);
        return (
          <>
            <Feed query={query} cache={cache} tab='news' />
            <IdentityEditor cache={cache} save={write} />
          </>
        );
      }

      render(
        <StrictMode>
          <StrictApp />
        </StrictMode>
      );

      // StrictMode double-fires the mount effects: both runs miss the cache
      // while the first is still pending, so the provider-level in-flight
      // slot collapses them into a single request
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

      await act(async () => {
        fireEvent.click(screen.getByTestId('save'));
      });
      // the simulated remount re-tracked ['news'], so invalidation
      // refetches it exactly once (deduped by the structural key)
      await waitFor(() => {
        expect(fetchFeed).toHaveBeenCalledTimes(2);
      });
      expect(fetchFeed).toHaveBeenLastCalledWith('news');

      await act(async () => {
        resolveQueue[1]('feed v2');
      });
      await waitFor(() => {
        expect(screen.getByTestId('feed-news').textContent).toBe('feed v2');
      });
      expect(cache.get(['news'])).toEqual(['feed v2', expect.any(Number)]);
    });

    it('should purge a target without live consumers and not refetch it', async () => {
      const {resolveQueue, fetchFeed} = deferredFetch();
      const cache = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000
      });

      function OnlyFeed() {
        const query = useInjectable(fetchFeed);
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

      // after unmount the entry survives (that is what a cache is for) …
      unmount();
      expect(cache.get(['news'])).toEqual(['feed v1', expect.any(Number)]);

      // … and the standalone invalidate() still purges it, with no
      // injectable reference at all — the provider IS the address — and
      // without a refetch: no mounted consumer subscribed to the event
      act(() => {
        invalidate([cache]);
      });
      expect(cache.get(['news'])).toBeUndefined();
      expect(fetchFeed).toHaveBeenCalledTimes(1);
    });

    it('should refresh every consumer of a shared provider, across injectables', async () => {
      const {resolveQueue, fetchFeed} = deferredFetch();
      const save = vi.fn(() => Promise.resolve('saved'));
      const cache = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000
      });

      // Both tabs share the provider; a bare-provider target addresses the
      // data itself, so BOTH mounted consumers — each with its own
      // injectable and result broadcast — refetch their seen tuples.
      function TwoTabsAndEditor() {
        const newsQuery = useInjectable(fetchFeed);
        const sportsQuery = useInjectable(fetchFeed);
        const write = useInjectable(save);
        return (
          <>
            <Feed query={newsQuery} cache={cache} tab='news' />
            <Feed query={sportsQuery} cache={cache} tab='sports' />
            <IdentityEditor cache={cache} save={write} />
          </>
        );
      }

      render(<TwoTabsAndEditor />);

      await waitFor(() => {
        expect(resolveQueue.length).toBe(2);
      });
      await act(async () => {
        resolveQueue[0]('news v1');
        resolveQueue[1]('sports v1');
      });
      await waitFor(() => {
        expect(screen.getByTestId('feed-news').textContent).toBe('news v1');
        expect(screen.getByTestId('feed-sports').textContent).toBe('sports v1');
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('save'));
      });
      // the clear() event reaches both consumers: two more fetches
      await waitFor(() => {
        expect(fetchFeed).toHaveBeenCalledTimes(4);
      });

      await act(async () => {
        resolveQueue[2]('news v2');
        resolveQueue[3]('sports v2');
      });
      await waitFor(() => {
        expect(screen.getByTestId('feed-news').textContent).toBe('news v2');
        expect(screen.getByTestId('feed-sports').textContent).toBe('sports v2');
      });
    });

    it('should revalidate passively when the cache is purged outside invalidate()', async () => {
      const {resolveQueue, fetchFeed} = deferredFetch();
      const cache = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000
      });

      function OnlyFeed() {
        const query = useInjectable(fetchFeed);
        return <Feed query={query} cache={cache} tab='news' />;
      }

      render(<OnlyFeed />);

      await waitFor(() => {
        expect(resolveQueue.length).toBe(1);
      });
      await act(async () => {
        resolveQueue[0]('feed v1');
      });
      await waitFor(() => {
        expect(screen.getByTestId('feed-news').textContent).toBe('feed v1');
      });

      // deletePrefix (or delete/clear — a devtools panel button, any
      // writer) is not library plumbing, yet the mounted consumer refreshes
      // through the very same deletion event
      await act(async () => {
        cache.deletePrefix?.(stableHash(['news']).slice(0, 3));
      });
      await waitFor(() => {
        expect(fetchFeed).toHaveBeenCalledTimes(2);
      });
      expect(cache.get(['news'])).toBeUndefined();

      await act(async () => {
        resolveQueue[1]('feed v2');
      });
      await waitFor(() => {
        expect(screen.getByTestId('feed-news').textContent).toBe('feed v2');
      });
    });

    it('should throw on a non-provider invalidate target', () => {
      expect(() => invalidate([{}] as any)).toThrow(
        /invalidate expects cache providers/
      );
    });

    it('should warn and skip a prefix target whose provider lacks deleteWhere', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const backing = new Map<string, [string, number]>();
        backing.set('news', ['v1', Date.now()]);
        const bare = {
          get: (args: [string]) => backing.get(args[0]),
          set: (args: [string], v: string) =>
            void backing.set(args[0], [v, Date.now()]),
          delete: (args: [string]) => void backing.delete(args[0]),
          clear: () => backing.clear()
        };

        invalidate([[bare as any, 'news']]);

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0]![0]).toContain('deleteWhere');
        // nothing was purged — the unusable target was skipped
        expect(backing.get('news')).toEqual(['v1', expect.any(Number)]);
      } finally {
        errorSpy.mockRestore();
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

    it('should track loading around a wrapped call', async () => {
      let resolveFn!: (v: string) => void;
      const fetchData = () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        });

      function TestComponent() {
        const [loading, wrap] = useLoadingFn();
        // Capture the wrapped fn once: the count it toggles lives in state.
        const [wrapped] = useState(() => wrap(fetchData));
        useEffect(() => {
          void wrapped();
        }, [wrapped]);
        return (
          <span data-testid='loading'>{loading ? 'loading' : 'idle'}</span>
        );
      }

      render(<TestComponent />);
      // the effect already fired the wrapped call inside act
      expect(screen.getByTestId('loading').textContent).toBe('loading');

      await act(async () => {
        resolveFn('done');
      });
      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('idle');
      });
    });
  });

  describe('useInjectBefore', () => {
    it('should be defined', () => {
      expect(useInjectBefore).toBeDefined();
    });

    it('should apply each registered wrapper exactly once per call across StrictMode remounts', async () => {
      const applied: number[] = [];
      let calls = 0;

      function TestComponent() {
        const injectable = useInjectable(async (x: number) => {
          calls++;
          return x;
        });
        useInject(injectable, (f) => {
          applied.push(1);
          return f;
        });
        useEffect(() => {
          void injectable(1);
        }, [injectable]);
        return null;
      }

      render(
        <StrictMode>
          <TestComponent />
        </StrictMode>
      );
      await act(async () => {});

      // StrictMode mounts, unmounts, remounts: the trampoline is re-added
      // (not duplicated), and each of the two effect-driven calls runs the
      // wrapper chain exactly once.
      expect(calls).toBe(2);
      expect(applied).toHaveLength(2);
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

    it('records a failed tick for error channels that mount later', async () => {
      vi.useFakeTimers();
      try {
        // The gap this test pins: at tick time NO error channel is
        // mounted (no useError/useFailureCount/useArgsStatus anywhere on
        // the injectable), so no wrapper in the chain records the settle
        // outcome. A reader mounting AFTER the failed tick must still
        // find the retained error — the poller records it itself.
        const failure = new Error('tick failed');
        let mode: 'fail' | 'ok' = 'fail';
        const fetchData = vi.fn(() =>
          mode === 'fail'
            ? Promise.reject<string>(failure)
            : Promise.resolve<string>('ok')
        );
        let latest!: ArgsStatus;
        let sharedError: Error | undefined;
        function Poller({
          injectable
        }: {
          injectable: (key: string) => Promise<string>;
        }) {
          usePolling(injectable, 1000, {args: ['k']});
          return null;
        }
        function Reader({
          injectable
        }: {
          injectable: (key: string) => Promise<string>;
        }) {
          sharedError = useError(injectable);
          latest = useArgsStatus(injectable, ['k']);
          return null;
        }
        function Owner({withReader}: {withReader?: boolean}) {
          const injectable = useInjectable(fetchData);
          return (
            <>
              <Poller injectable={injectable} />
              {withReader && <Reader injectable={injectable} />}
            </>
          );
        }

        const {rerender} = render(<Owner />);
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchData).toHaveBeenCalledTimes(1);

        // The reader mounts after the failed tick and must see the
        // outcome on both channels: the injectable-level broadcast
        // (useError) and the keyed slot (useArgsStatus).
        rerender(<Owner withReader />);
        expect(sharedError).toBe(failure);
        expect(latest.error).toBe(failure);
        expect(latest.failureCount).toBe(1);

        // A successful tick clears the record; the late reader observes
        // the cleared state without ever having seen the failure live.
        mode = 'ok';
        await vi.advanceTimersByTimeAsync(1000);
        expect(sharedError).toBeUndefined();
        expect(latest.error).toBeUndefined();
        expect(latest.failureCount).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the recorded error on the next successful tick even with no reader mounted', async () => {
      vi.useFakeTimers();
      try {
        // The unclaimed emission path end to end: fail a tick with no
        // reader mounted (the poller records), succeed a tick with no
        // reader mounted (the poller clears), THEN mount the reader —
        // a stale failure left behind would surface here.
        const failure = new Error('tick failed');
        let mode: 'fail' | 'ok' = 'fail';
        const fetchData = vi.fn(() =>
          mode === 'fail'
            ? Promise.reject<string>(failure)
            : Promise.resolve<string>('ok')
        );
        let latest!: ArgsStatus;
        let sharedError: Error | undefined;
        function Poller({
          injectable
        }: {
          injectable: (key: string) => Promise<string>;
        }) {
          usePolling(injectable, 1000, {args: ['k']});
          return null;
        }
        function Reader({
          injectable
        }: {
          injectable: (key: string) => Promise<string>;
        }) {
          sharedError = useError(injectable);
          latest = useArgsStatus(injectable, ['k']);
          return null;
        }
        function Owner({withReader}: {withReader?: boolean}) {
          const injectable = useInjectable(fetchData);
          return (
            <>
              <Poller injectable={injectable} />
              {withReader && <Reader injectable={injectable} />}
            </>
          );
        }

        const {rerender} = render(<Owner />);
        await vi.advanceTimersByTimeAsync(1000);
        mode = 'ok';
        await vi.advanceTimersByTimeAsync(1000);
        rerender(<Owner withReader />);
        expect(sharedError).toBeUndefined();
        expect(latest.error).toBeUndefined();
        expect(latest.failureCount).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not double-count a failed tick when an error channel is mounted', async () => {
      vi.useFakeTimers();
      try {
        // Reader mounted from the start: its useErrorWrapper owns the
        // emission. The poller's own tracking must stay passive for that
        // call — one failed tick, one failureCount tally, one broadcast.
        const failure = new Error('tick failed');
        let mode: 'fail' | 'ok' = 'fail';
        const fetchData = vi.fn((_key: string) =>
          mode === 'fail'
            ? Promise.reject<string>(failure)
            : Promise.resolve<string>('ok')
        );
        let latest!: ArgsStatus;
        let sharedError: Error | undefined;
        function TestComponent() {
          const injectable = useInjectable(fetchData);
          usePolling(injectable, 1000, {args: ['k']});
          sharedError = useError(injectable);
          latest = useArgsStatus(injectable, ['k']);
          return null;
        }
        render(<TestComponent />);
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchData).toHaveBeenCalledTimes(1);
        expect(sharedError).toBe(failure);
        expect(latest.error).toBe(failure);
        expect(latest.failureCount).toBe(1);

        mode = 'ok';
        await vi.advanceTimersByTimeAsync(1000);
        expect(latest.error).toBeUndefined();
        expect(latest.failureCount).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips ticks while pending without writing an error', async () => {
      vi.useFakeTimers();
      try {
        const resolvers: Array<(v: string) => void> = [];
        const rejects: Array<(e: Error) => void> = [];
        const fetchData = vi.fn(
          (_key: string) =>
            new Promise<string>((resolve, reject) => {
              resolvers.push(resolve);
              rejects.push(reject);
            })
        );
        let latest!: ArgsStatus;
        function TestComponent() {
          const injectable = useInjectable(fetchData);
          usePolling(injectable, 1000, {args: ['k']});
          latest = useArgsStatus(injectable, ['k']);
          return null;
        }
        render(<TestComponent />);
        await vi.advanceTimersByTimeAsync(3000);
        // one pending call; the three skipped ticks wrote nothing
        expect(fetchData).toHaveBeenCalledTimes(1);
        expect(latest.loading).toBe(true);
        expect(latest.error).toBeUndefined();
        expect(latest.failureCount).toBe(0);

        await act(async () => {
          rejects[0]!(new Error('slow failure'));
        });
        expect(fetchData).toHaveBeenCalledTimes(1);
        expect(latest.loading).toBe(false);
        expect(latest.error?.message).toBe('slow failure');
        expect(latest.failureCount).toBe(1);
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

    it('should skip the refetch while the cached entry is younger than staleTime (refetchOnWindowFocus semantics)', async () => {
      const fetchUser = vi.fn(async (id: number) => `user ${id}`);
      const cache = createMemoryCacheProvider<string, [number]>();
      function TestComponent() {
        const injectable = useInjectable(fetchUser);
        useFocusRevalidate(injectable, {
          args: [42],
          cacheProvider: cache,
          staleTime: 20
        });
        return null;
      }
      render(<TestComponent />);
      cache.set([42], 'user 42 warmed');
      // Fresh entry: the focus event skips the revalidation entirely —
      // not even a call is made.
      await act(async () => {
        fireEvent(window, new Event('focus'));
      });
      expect(fetchUser).not.toHaveBeenCalled();
      // Once the entry ages past staleTime, the same event refetches.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      await act(async () => {
        fireEvent(window, new Event('focus'));
      });
      expect(fetchUser).toHaveBeenCalledTimes(1);
      expect(fetchUser).toHaveBeenCalledWith(42);
    });

    it('should not leak an unhandled rejection when a focus revalidation rejects', async () => {
      const fetchData = vi.fn(async () => {
        throw new Error('focus fail');
      });
      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useFocusRevalidate(injectable);
        return null;
      }
      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        render(<TestComponent />);
        await act(async () => {
          fireEvent(window, new Event('focus'));
        });
        // Long enough for an unobserved rejection to surface as unhandled.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(fetchData).toHaveBeenCalledTimes(1);
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
    });
  });

  describe('useReconnectRevalidate', () => {
    it('should gate the reconnect refetch by the cached entry age when a cacheProvider is given', async () => {
      const fetchUser = vi.fn(async (id: number) => `user ${id}`);
      const cache = createMemoryCacheProvider<string, [number]>();
      function TestComponent() {
        const injectable = useInjectable(fetchUser);
        useReconnectRevalidate(injectable, {
          args: [7],
          cacheProvider: cache,
          staleTime: 20
        });
        return null;
      }
      render(<TestComponent />);
      cache.set([7], 'user 7 warmed');
      await act(async () => {
        fireEvent(window, new Event('online'));
      });
      expect(fetchUser).not.toHaveBeenCalled();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      await act(async () => {
        fireEvent(window, new Event('online'));
      });
      expect(fetchUser).toHaveBeenCalledTimes(1);
      expect(fetchUser).toHaveBeenCalledWith(7);
    });

    it('should not leak an unhandled rejection when a reconnect revalidation rejects', async () => {
      const fetchData = vi.fn(async () => {
        throw new Error('reconnect fail');
      });
      function TestComponent() {
        const injectable = useInjectable(fetchData);
        useReconnectRevalidate(injectable);
        return null;
      }
      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        render(<TestComponent />);
        await act(async () => {
          fireEvent(window, new Event('online'));
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(fetchData).toHaveBeenCalledTimes(1);
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
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

    it('should warn in DEV when a suspension outlives the grace window with no call ever started', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // No driver anywhere: nothing ever calls the injectable.
      const fetchData = vi.fn(async () => 'never fetched');

      function Owner() {
        const fetchValue = useInjectable(fetchData);
        return (
          <Suspense fallback={<div>loading…</div>}>
            <SuspenseReader fetchValue={fetchValue} />
          </Suspense>
        );
      }

      try {
        render(<Owner />);
        expect(screen.getByText('loading…')).toBeDefined();
        await waitFor(
          () => {
            expect(warn).toHaveBeenCalled();
          },
          {timeout: 3000}
        );
        expect(warn.mock.calls[0]![0]).toMatch(/useSuspenseResult/);
        expect(warn.mock.calls[0]![0]).toMatch(/no call in flight/);
        // The warning is purely diagnostic: nothing fetched, still stalled.
        expect(fetchData).not.toHaveBeenCalled();
        expect(screen.getByText('loading…')).toBeDefined();
      } finally {
        warn.mockRestore();
      }
    });

    it('should not warn while a driver keeps a call in flight through the grace window', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let resolveFn!: (value: string) => void;
      const fetchData = vi.fn(
        () => new Promise<string>((resolve) => (resolveFn = resolve))
      );

      function Owner() {
        const fetchValue = useInjectable(fetchData);
        useRun(fetchValue, []);
        return (
          <Suspense fallback={<div>loading…</div>}>
            <SuspenseReader fetchValue={fetchValue} />
          </Suspense>
        );
      }

      try {
        render(<Owner />);
        expect(screen.getByText('loading…')).toBeDefined();
        // Well past the grace window with the call still pending: the
        // in-flight promise is exactly what the reader suspends on, so no
        // stall warning may fire.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1200));
        });
        expect(
          warn.mock.calls.filter((call) =>
            String(call[0]).includes('useSuspenseResult')
          )
        ).toEqual([]);
        await act(async () => {
          resolveFn('late data');
        });
        expect(await screen.findByText('late data')).toBeDefined();
        expect(fetchData).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
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

describe('useArgsStatus (per-key loading and error)', () => {
  // THE regression this hook exists for: before it, loading/error lived on
  // injectable-level stores, so two concurrent calls of one injectable with
  // different args shared one flag and one error slot — whichever settled
  // last won, and a sibling row's spinner/error was clobbered.
  // Note: each Row below creates its OWN injectable instance (useInjectable
  // per component), so the shared-slot scenario requires one host that both
  // observers and callers go through — that is the shape every test here
  // uses (one `useInjectable`, lifted to the test via closure capture).

  it('independent loading across two consumers sharing one injectable', async () => {
    const resolvers: Record<string, (v: string) => void> = {};
    const fetchData = vi.fn(async (id: string) => {
      return new Promise<string>((resolve) => {
        resolvers[id] = resolve;
      });
    });

    let injectable!: (id: string) => Promise<string>;
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn;
      const a = useArgsStatus(fn, ['a']);
      const b = useArgsStatus(fn, ['b']);
      return (
        <div>
          <div data-testid='row-a'>{a.loading ? 'loading' : 'done'}</div>
          <div data-testid='row-b'>{b.loading ? 'loading' : 'done'}</div>
        </div>
      );
    }

    render(<TestComponent />);

    // Two concurrent calls, different args, same injectable.
    await act(async () => {
      void injectable('a');
      void injectable('b');
    });
    expect(screen.getByTestId('row-a').textContent).toBe('loading');
    expect(screen.getByTestId('row-b').textContent).toBe('loading');

    // `a` settles: ONLY row a clears — the injectable-level loading flag
    // (count > 0) is still true, but row b's keyed slot is untouched.
    await act(async () => {
      resolvers['a']!('A');
    });
    expect(screen.getByTestId('row-a').textContent).toBe('done');
    expect(screen.getByTestId('row-b').textContent).toBe('loading');

    await act(async () => {
      resolvers['b']!('B');
    });
    expect(screen.getByTestId('row-a').textContent).toBe('done');
    expect(screen.getByTestId('row-b').textContent).toBe('done');
  });

  it('independent errors: one args failure never shows on the sibling key', async () => {
    const resolvers: Record<string, () => void> = {};
    const fetchData = vi.fn(async (id: string): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        resolvers[id] =
          id === 'bad' ? () => reject(new Error('boom')) : resolve;
      });
    });

    let injectable!: (id: string) => Promise<void>;
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn;
      const good = useArgsStatus(fn, ['good']);
      const bad = useArgsStatus(fn, ['bad']);
      return (
        <div>
          <div data-testid='good'>{good.error ? 'failed' : 'ok'}</div>
          <div data-testid='bad'>{bad.error ? 'failed' : 'ok'}</div>
        </div>
      );
    }

    render(<TestComponent />);

    await act(async () => {
      void injectable('good');
      // Captured: the keyed error must surface on the hook (React 18's
      // act flushes the rejection asynchronously — a bare `void` leaves
      // it unhandled), and `.catch` keeps the test's global state clean.
      void injectable('bad').catch(() => {});
    });
    await act(async () => {
      resolvers['bad']!();
    });

    // The failure of `bad` is visible ONLY on the bad row.
    expect(screen.getByTestId('bad').textContent).toBe('failed');
    expect(screen.getByTestId('good').textContent).toBe('ok');
    // A same-args success clears its own slot only.
    await act(async () => {
      resolvers['good']!();
    });
    expect(screen.getByTestId('good').textContent).toBe('ok');
    expect(screen.getByTestId('bad').textContent).toBe('failed');
  });

  it('reports the result scoped to its own key (data provenance)', async () => {
    const resolvers: Record<string, (v: string) => void> = {};
    const fetchData = vi.fn(
      (id: string) =>
        new Promise<string>((resolve) => {
          resolvers[id] = resolve;
        })
    );
    let injectable!: (id: string) => Promise<string>;
    let key = 'a';
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn;
      const status = useArgsStatus(fn, [key]);
      return <div data-testid='out'>{status.data ?? 'none'}</div>;
    }

    render(<TestComponent />);
    expect(screen.getByTestId('out').textContent).toBe('none');

    let promise!: Promise<string>;
    await act(async () => {
      promise = injectable('a');
    });
    await act(async () => {
      resolvers['a']!('result-for-a');
      await promise;
    });
    expect(screen.getByTestId('out').textContent).toBe('result-for-a');

    // While `b`'s call is in flight and `a`'s result is on display, the
    // scoped view shows nothing (provenance mismatch), not the stale key.
    key = 'b';
    await act(async () => {
      promise = injectable('b');
    });
    expect(screen.getByTestId('out').textContent).toBe('none');
    await act(async () => {
      resolvers['b']!('result-for-b');
      await promise;
    });
    expect(screen.getByTestId('out').textContent).toBe('result-for-b');
  });

  it('StrictMode double effects and repeated calls pair begin/end exactly once per call', async () => {
    // Per-call resolver queue: every invocation registers its own resolve.
    const resolvers: ((v: string) => void)[] = [];
    const fetchData = vi.fn(async (id: string) => {
      return new Promise<string>((resolve) => {
        resolvers.push(resolve);
      });
    });

    let injectable!: (id: string) => Promise<string>;
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn;
      const a = useArgsStatus(fn, ['a']);
      return <div data-testid='row'>{a.loading ? 'loading' : 'done'}</div>;
    }

    render(
      <StrictMode>
        <TestComponent />
      </StrictMode>
    );

    // The same call fired three times (event handler + StrictMode-style
    // re-entry): the slot counts up to 3, not less, and drains to 0.
    let p1!: Promise<string>;
    let p2!: Promise<string>;
    let p3!: Promise<string>;
    await act(async () => {
      p1 = injectable('a');
      p2 = injectable('a');
      p3 = injectable('a');
    });
    expect(screen.getByTestId('row').textContent).toBe('loading');

    await act(async () => {
      resolvers[0]!('1');
      await p1;
    });
    // two calls still in flight → still loading (per-key count = 2)
    expect(screen.getByTestId('row').textContent).toBe('loading');

    await act(async () => {
      resolvers[1]!('2');
      await p2;
    });
    expect(screen.getByTestId('row').textContent).toBe('loading');

    await act(async () => {
      resolvers[2]!('3');
      await p3;
    });
    expect(screen.getByTestId('row').textContent).toBe('done');

    // The slot is fully drained — a subsequent render observes no
    // leftover count (the deleted slot is the pairing proof).
    const {getKeyedStore} = await import('../src/async/base');
    const keyed = getKeyedStore(injectable);
    expect(keyed.keyed.get(stableHash(['a']))).toBeUndefined();
  });

  it('a rejected call releases its keyed slot and tallies failureCount', async () => {
    const fetchData = vi.fn(async (): Promise<string> => {
      throw new Error('x');
    });
    let injectable!: () => Promise<string>;
    let latest!: {loading: boolean; error: unknown; failureCount: number};
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn as never;
      latest = useArgsStatus(fn, []);
      return null;
    }
    render(<TestComponent />);

    await act(async () => {
      await injectable().catch(() => {});
    });
    expect(latest.loading).toBe(false);
    expect(latest.error).toBeInstanceOf(Error);
    expect(latest.failureCount).toBe(1);

    // The slot survives the settle (it holds the outcome) but holds no
    // in-flight count; a success clears the outcome and tally.
    const {getKeyedStore} = await import('../src/async/base');
    const keyed = getKeyedStore(injectable);
    expect(keyed.keyed.get(stableHash([]))!.count).toBe(0);

    fetchData.mockImplementation(async () => 'ok');
    await act(async () => {
      await injectable();
    });
    expect(latest.loading).toBe(false);
    expect(latest.error).toBeUndefined();
    expect(latest.failureCount).toBe(0);
    // The success settled the drained slot's outcome and reclaimed the
    // entry — no keyed residue after a clean settle (reclaim proof).
    expect(keyed.keyed.get(stableHash([]))).toBeUndefined();
  });

  it('signal-driven calls ({signal: true}) and plain calls land on ONE keyed slot', async () => {
    const resolvers: ((v: string) => void)[] = [];
    const fetchData = vi.fn(
      (id: string, _signal?: AbortSignal) =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    let injectable!: (id: string, signal?: AbortSignal) => Promise<string>;
    // drive = ['a'] mounts the useRun driver (fires the signal call);
    // drive = [] never matches a real fetch (fetchData requires an id).
    let drive: string[] = [];
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn;
      // The React-main path: useRun with {signal: true} appends the
      // signal as a trailing arg. The keyed wrapper must record the slot
      // under the TRIMMED key, so this hook reading ['a'] sees the
      // signal-driven call's loading (key-asymmetry regression: without
      // trimming, the slot was hashed '[a,#sig]' and never matched).
      useRun(fn, drive as unknown as Parameters<typeof fn>, {
        signal: true
      });
      const keyed = useArgsStatus(fn, ['a']);
      return <div data-testid='row'>{keyed.loading ? 'loading' : 'done'}</div>;
    }

    const {rerender} = render(<TestComponent />);
    expect(screen.getByTestId('row').textContent).toBe('done');
    // The idle mount still fires useRun(fn, [], signal) — args [] with a
    // lone trailing signal. That call hashes to a DIFFERENT (empty) key,
    // so the ['a'] read is done. Park it in the background.
    expect(fetchData).toHaveBeenCalledTimes(1);

    // Mount the driver: useRun re-runs with the SIGNAL call for ['a'].
    await act(async () => {
      drive = ['a'];
      rerender(<TestComponent />);
    });
    // The wrapper hashed the trailing signal away — the hook reading
    // ['a'] observes the call's loading (THE regression; without the
    // trim this stayed 'done' forever).
    expect(fetchData).toHaveBeenCalledTimes(2);
    expect(fetchData.mock.calls[1]![0]).toBe('a');
    expect(fetchData.mock.calls[1]![1]).toBeInstanceOf(AbortSignal);
    expect(screen.getByTestId('row').textContent).toBe('loading');

    // A plain refetch-style call of the same logical args joins the SAME
    // slot (count 2) instead of opening a second one.
    let plain!: Promise<string>;
    await act(async () => {
      plain = injectable('a');
    });
    expect(screen.getByTestId('row').textContent).toBe('loading');

    // Settle the signal call: the plain call still runs → still loading.
    await act(async () => {
      resolvers[1]!('s');
    });
    expect(screen.getByTestId('row').textContent).toBe('loading');

    // Settle the plain call: ['a'] drained. The idle [] call is still
    // parked on resolvers[0], but it occupies a DIFFERENT key — it must
    // not keep the ['a'] row loading.
    await act(async () => {
      resolvers[2]!('p');
    });
    expect(screen.getByTestId('row').textContent).toBe('done');

    // The parked idle call proves cross-key isolation: settle it now, the
    // row stays done.
    await act(async () => {
      resolvers[0]!('idle');
    });
    expect(screen.getByTestId('row').textContent).toBe('done');
  });

  it('slow old call never clobbers the outcome of a newer same-args call', async () => {
    const resolvers: Record<string, (v: string) => void> = {};
    let flip = false;
    const fetchData = vi.fn(async () => {
      if (flip) {
        return new Promise<string>((resolve) => {
          resolvers.slow = resolve;
        });
      }
      return 'fast-ok';
    });
    let injectable!: () => Promise<string>;
    let latest!: {loading: boolean; error: unknown};
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn;
      latest = useArgsStatus(fn, []);
      return null;
    }
    render(<TestComponent />);

    // Call 1 succeeds quickly; call 2 hangs (slow path); call 3 succeeds.
    await act(async () => {
      await injectable();
    });
    expect(latest.error).toBeUndefined();

    flip = true;
    let slow!: Promise<string>;
    await act(async () => {
      slow = injectable();
    });
    expect(latest.loading).toBe(true);
    flip = false;
    await act(async () => {
      await injectable();
    });
    expect(latest.loading).toBe(true);
    // The fresh success cleared the error slot while the slow call is
    // still in flight.
    expect(latest.error).toBeUndefined();

    // The slow call resolves LATER: the per-key seq guard keeps the newer
    // success's cleared state authoritative — no resurrected error, and
    // the loading flag drains exactly at the slow call's end.
    await act(async () => {
      resolvers.slow!('late');
      await slow;
    });
    expect(latest.loading).toBe(false);
    expect(latest.error).toBeUndefined();
  });

  it('clean settled keys reclaim their slots — no permanent per-key retention', async () => {
    const fetchData = vi.fn(async (n: number) => `v${n}`);
    let injectable!: (n: number) => Promise<string>;
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn;
      return null;
    }
    render(<TestComponent />);

    // The reviewer's A/B heap measurement (every args key permanently
    // retained ~65B — slot plus seq-guard entry) restated as the
    // deterministic observable: after 20 distinct keys each settle and
    // drain, the keyed map must be EMPTY — the guard-entry half of the
    // reclaim is covered behaviorally by the slot-reuse test below.
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await injectable(i);
      });
    }
    const {getKeyedStore, keyedSeqs} = await import('../src/async/base');
    const keyed = getKeyedStore(injectable);
    expect(keyed.keyed.size).toBe(0);
    // The guard-entry half of the retention: keyedSeqs' per-key entries
    // must go WITH their slots — 0.14.0 kept one entry (key string plus
    // {next, applied}) per args key forever, the reviewer's ~65B/key
    // A/B heap delta.
    expect(keyedSeqs.get(keyed)?.size ?? 0).toBe(0);
  });

  it('an uncleared stale verdict keeps its keyed slot; clearing it releases the slot', async () => {
    // Regression of the per-key stale migration (StaleStore → keyed
    // field): `stale: true` is contract state like a failure outcome —
    // reclaimable never — while clearing the verdict is the last
    // observable content of a drained slot and releases it.
    const cache = createMemoryCacheProvider<string, [number]>();
    let resolveRefetch!: (v: string) => void;
    let calls = 0;
    const fetchUser = vi.fn((id: number) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(`user ${id}`);
      return new Promise<string>((resolve) => (resolveRefetch = resolve));
    });
    let injectable!: (id: number) => Promise<string>;
    let isStale!: boolean;
    function TestComponent() {
      const fn = useInjectable(fetchUser);
      injectable = fn;
      isStale = useCache(fn, cache, 30);
      useRun(fn, [1]);
      return null;
    }
    render(<TestComponent />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(isStale).toBe(false);
    // The settled, drained first call left no slot behind…
    const {getKeyedStore} = await import('../src/async/base');
    expect(getKeyedStore(injectable).keyed.size).toBe(0);

    // …the stale cache hit materializes one holding the raised verdict,
    // and the hanging background refetch keeps it alive.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      await injectable(1);
    });
    await waitFor(() => {
      expect(isStale).toBe(true);
    });
    const keyed = getKeyedStore(injectable);
    expect(keyed.keyed.size).toBe(1);
    expect(keyed.keyed.get(stableHash([1]))?.stale).toBe(true);

    // The refetch succeeds: the verdict clears and the drained slot goes
    // with it — no per-key retention for resolved staleness either.
    await act(async () => {
      resolveRefetch!('user 1 v2');
    });
    await waitFor(() => {
      expect(isStale).toBe(false);
    });
    expect(keyed.keyed.size).toBe(0);
  });

  it('failure slots are capped: 300 failed distinct args retain at most KEYED_SLOTS_LIMIT', async () => {
    const fetchData = vi.fn(async (n: number) => {
      throw new Error(`boom-${n}`);
    });
    let injectable!: (n: number) => Promise<string>;
    let latest!: {loading: boolean; error: unknown; failureCount: number};
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn;
      latest = useArgsStatus(fn, [299]);
      return null;
    }
    render(<TestComponent />);

    // The reviewer's repro: 300 failing args left 300 slots — Error
    // references included — in the map forever. With the cap, sequential
    // inserts evict oldest-first quiescent slots, so exactly the newest
    // LIMIT keys survive.
    for (let i = 0; i < 300; i++) {
      await act(async () => {
        await injectable(i).catch(() => {});
      });
    }
    const {getKeyedStore, KEYED_SLOTS_LIMIT, keyedSeqs} =
      await import('../src/async/base');
    const keyed = getKeyedStore(injectable);
    expect(keyed.keyed.size).toBe(KEYED_SLOTS_LIMIT);
    // Evicted keys took their guard entries along — the cap bounds BOTH
    // maps, not just the slot map.
    expect(keyedSeqs.get(keyed)?.size ?? 0).toBeLessThanOrEqual(
      KEYED_SLOTS_LIMIT
    );
    // The LIVE tail keeps its contract state: the newest failure stays
    // observable — eviction drops the oldest, never the fresh outcome.
    expect(keyed.keyed.get(stableHash([299]))).toBeDefined();
    expect(latest.error).toBeInstanceOf(Error);
    expect(latest.failureCount).toBe(1);
  });

  it('a concurrent burst of failed keys drains back under the cap', async () => {
    const fetchData = vi.fn((n: number) => Promise.reject(new Error(`x${n}`)));
    let injectable!: (n: number) => Promise<string>;
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn;
      return null;
    }
    render(<TestComponent />);

    // 150 DISTINCT keys fired without waiting: while in flight nothing is
    // evictable, so the map overshoots — but the overshoot must not
    // OUTLIVE the burst (0.14.0 never evicted on drain at all).
    await act(async () => {
      await Promise.all(
        Array.from({length: 150}, (_, i) => injectable(i).catch(() => {}))
      );
    });
    const {getKeyedStore, KEYED_SLOTS_LIMIT} =
      await import('../src/async/base');
    const keyed = getKeyedStore(injectable);
    expect(keyed.keyed.size).toBeLessThanOrEqual(KEYED_SLOTS_LIMIT);
  });

  it('out-of-order settlement leaves no husk, and slot reuse keeps the seq guard honest', async () => {
    const resolvers: ((v: string) => void)[] = [];
    const fetchData = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );
    let injectable!: () => Promise<string>;
    let latest!: {loading: boolean; error: unknown; failureCount: number};
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn;
      latest = useArgsStatus(fn, []);
      return null;
    }
    render(<TestComponent />);

    // The reviewer's husk repro: the NEWER call settles first (success,
    // but the older call is still in flight → no reclaim then); the older
    // call settles LAST — its emission is dropped by the per-key guard,
    // the exact path whose reclaim branch never ran in 0.14.0.
    let p1!: Promise<string>;
    let p2!: Promise<string>;
    await act(async () => {
      p1 = injectable();
    });
    await act(async () => {
      p2 = injectable();
    });
    await act(async () => {
      resolvers[1]!('newer-ok');
      await p2;
    });
    expect(latest.loading).toBe(true); // the older call still runs
    await act(async () => {
      resolvers[0]!('older-ok');
      await p1;
    });
    expect(latest.loading).toBe(false);
    expect(latest.error).toBeUndefined();
    const {getKeyedStore} = await import('../src/async/base');
    const keyed = getKeyedStore(injectable);
    expect(keyed.keyed.get(stableHash([]))).toBeUndefined();
    expect(keyed.keyed.size).toBe(0);

    // The slot AND its guard entry were reclaimed together, so the key is
    // reused under a FRESH ticket numbering. The guard must stay honest
    // there: an older call settling LAST with a failure must not surface
    // over a newer success — the exact regression a guard-entry deletion
    // with a ticket still pending would produce.
    const settles: Array<(v?: string) => void> = [];
    fetchData.mockImplementation(
      () =>
        new Promise<string>((resolve, reject) => {
          settles.push((v) =>
            v === undefined ? reject(new Error('old-fail')) : resolve(v)
          );
        })
    );
    let p3!: Promise<string>;
    let p4!: Promise<string>;
    await act(async () => {
      p3 = injectable().catch(() => 'caught-old-fail');
      p4 = injectable();
    });
    await act(async () => {
      settles[1]!('fresh-ok');
      await p4;
    });
    await act(async () => {
      settles[0]!(); // the older call now rejects — stale ticket
      await p3;
    });
    expect(latest.error).toBeUndefined();
    expect(latest.failureCount).toBe(0);
    expect(keyed.keyed.get(stableHash([]))).toBeUndefined();
    expect(keyed.keyed.size).toBe(0);
  });

  it('dataUpdatedAt and dataUpdateCount stamp on every successful settle of the same args', async () => {
    const resolvers: Array<(v: string) => void> = [];
    const fetchData = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );
    let injectable!: () => Promise<string>;
    let latest!: ArgsStatus;
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn;
      latest = useArgsStatus(fn, []);
      return null;
    }
    render(<TestComponent />);
    // No result yet: the fields are as absent as `data` itself.
    expect(latest.data).toBeUndefined();
    expect(latest.dataUpdatedAt).toBeUndefined();
    expect(latest.dataUpdateCount).toBeUndefined();

    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      let p1!: Promise<string>;
      await act(async () => {
        p1 = injectable();
      });
      // In flight, nothing settled yet — still unstamped.
      expect(latest.dataUpdatedAt).toBeUndefined();
      await act(async () => {
        resolvers[0]!('one');
        await p1;
      });
      expect(latest.data).toBe('one');
      expect(latest.dataUpdatedAt).toBe(1_000);
      expect(latest.dataUpdateCount).toBe(1);

      // A same-args re-success advances BOTH the timestamp and the count.
      now.mockReturnValue(2_000);
      let p2!: Promise<string>;
      await act(async () => {
        p2 = injectable();
      });
      await act(async () => {
        resolvers[1]!('two');
        await p2;
      });
      expect(latest.data).toBe('two');
      expect(latest.dataUpdatedAt).toBe(2_000);
      expect(latest.dataUpdateCount).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  it('a failed refetch leaves dataUpdatedAt and dataUpdateCount at the last success', async () => {
    let fail = false;
    const fetchData = vi.fn(async (): Promise<string> => {
      if (fail) throw new Error('boom');
      return 'ok';
    });
    let injectable!: () => Promise<string>;
    let latest!: ArgsStatus;
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn;
      latest = useArgsStatus(fn, []);
      return null;
    }
    render(<TestComponent />);

    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      await act(async () => {
        await injectable();
      });
      expect(latest.data).toBe('ok');
      expect(latest.dataUpdatedAt).toBe(1_000);
      expect(latest.dataUpdateCount).toBe(1);

      // The refetch fails LATER in clock time: the keyed error surfaces,
      // but the settle metadata of the displayed data must not move.
      now.mockReturnValue(2_000);
      fail = true;
      await act(async () => {
        await injectable().catch(() => {});
      });
      expect(latest.error).toBeDefined();
      expect(latest.failureCount).toBe(1);
      expect(latest.data).toBe('ok');
      expect(latest.dataUpdatedAt).toBe(1_000);
      expect(latest.dataUpdateCount).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  it('dataUpdatedAt and dataUpdateCount are scoped per key like data', async () => {
    const resolvers: Record<string, (v: string) => void> = {};
    const fetchData = vi.fn(
      (id: string) =>
        new Promise<string>((resolve) => {
          resolvers[id] = resolve;
        })
    );
    let injectable!: (id: string) => Promise<string>;
    let latestA!: ArgsStatus;
    let latestB!: ArgsStatus;
    function TestComponent() {
      const fn = useInjectable(fetchData);
      injectable = fn;
      latestA = useArgsStatus(fn, ['a']);
      latestB = useArgsStatus(fn, ['b']);
      return null;
    }
    render(<TestComponent />);

    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      let pa!: Promise<string>;
      await act(async () => {
        pa = injectable('a');
      });
      await act(async () => {
        resolvers['a']!('A');
        await pa;
      });
      expect(latestA.dataUpdatedAt).toBe(1_000);
      expect(latestA.dataUpdateCount).toBe(1);
      // `b` never settled: its fields stay absent (not zero, not t1).
      expect(latestB.dataUpdatedAt).toBeUndefined();
      expect(latestB.dataUpdateCount).toBeUndefined();

      // Provenance moves to `b`: a's fields drop together with its data,
      // b carries its own timestamp and starts its own series.
      now.mockReturnValue(2_000);
      let pb!: Promise<string>;
      await act(async () => {
        pb = injectable('b');
      });
      await act(async () => {
        resolvers['b']!('B');
        await pb;
      });
      expect(latestA.data).toBeUndefined();
      expect(latestA.dataUpdatedAt).toBeUndefined();
      expect(latestA.dataUpdateCount).toBeUndefined();
      expect(latestB.dataUpdatedAt).toBe(2_000);
      expect(latestB.dataUpdateCount).toBe(1);

      // `a` retakes the display: its series RESTARTS at 1 — the counter
      // follows the displayed series (see ArgsStatus.dataUpdateCount
      // docs), it is not a lifetime per-key tally.
      now.mockReturnValue(3_000);
      let pa2!: Promise<string>;
      await act(async () => {
        pa2 = injectable('a');
      });
      await act(async () => {
        resolvers['a']!('A2');
        await pa2;
      });
      expect(latestA.data).toBe('A2');
      expect(latestA.dataUpdatedAt).toBe(3_000);
      expect(latestA.dataUpdateCount).toBe(1);
    } finally {
      now.mockRestore();
    }
  });
});

describe('in-flight abort yielding (load slot vacated synchronously)', () => {
  // The regression this block exists for: a provider.load in-flight slot is
  // vacated in a then-microtask, but an aborted request's rejection happens
  // SYNCHRONOUSLY inside abort(). In the window between the two, a new load
  // for the same key joined the dead promise: the replacement consumer
  // inherited AbortError, never ran its factory, and sat in a permanent
  // error state (painless: PreviewLink hover→click, comments stuck on
  // "Failed to load comments"). The fix: a signal-carrying load that CREATED
  // the slot vacates it from the signal's abort listener — synchronously,
  // silently — so same-stack successors start a fresh request instead.

  // A fetch with real abort semantics: the signal's abort listener rejects
  // synchronously, exactly like the browser's fetch. A PLAIN function on
  // purpose: each test wraps it in its own vi.fn, and wrapping an already-
  // mocked fn shares the mock state (call counts would bleed across tests).
  const abortAwareFetch = (slug: string, signal?: AbortSignal) =>
    new Promise<string[]>((resolve, reject) => {
      const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, {once: true});
      }
      setTimeout(() => resolve([`${slug} ok`]), 30);
    });
  // Module-stable args tuple: useRun without {hash} compares by reference,
  // and an inline literal would re-run (abort + refetch) on every rerender.
  const ARGS: [string] = ['s'];

  it('unmount-abort then same-stack remount: the new consumer starts fresh, not on the dead promise', async () => {
    const fetchData = vi.fn(abortAwareFetch);
    const cache = createMemoryCacheProvider<
      string[],
      Parameters<typeof abortAwareFetch>
    >({cacheTime: 60000});
    let deleteEvents = 0;
    cache.subscribe!((e) => {
      if (e.type === 'delete') deleteEvents++;
    });
    let latest!: ArgsStatus;
    function Consumer() {
      const injectable = useInjectable(fetchData);
      useCache(injectable, cache);
      useRun(injectable, ARGS, {signal: true});
      latest = useArgsStatus(injectable, ARGS);
      return null;
    }

    const a = render(<Consumer />);
    // A's wrapper chain resolves its cache read in a microtask — the race
    // is fully set up before any of them run, exactly like the consumer
    // app's unmount-then-remount in one commit.

    // The race, in one synchronous stack: A's cleanup aborts its signal
    // (the mock fetch rejects inside abort()), then B mounts with the same
    // args BEFORE the microtask that would vacate the slot. B's queued
    // load lands ahead of the dead promise's settle microtask.
    a.unmount();
    const b = render(<Consumer />);

    await waitFor(() => {
      expect(latest.data).toEqual(['s ok']);
    });
    expect(latest.error).toBeUndefined();
    expect(latest.loading).toBe(false);
    // A's aborted request + B's fresh one. Before the fix B joined the
    // dead promise: totalCalls stayed at 1 and B sat in AbortError forever.
    expect(fetchData).toHaveBeenCalledTimes(2);
    // The drop is silent: not one delete event fired (one would have made
    // mounted consumers re-run the args — a double fetch).
    expect(deleteEvents).toBe(0);
    // B's entry settled in the cache. useRun({signal: true}) appends the
    // signal to the args, and stableHash collapses every signal to one
    // placeholder, so the twin tuple addresses the entry.
    expect(cache.peek!(['s', new AbortController().signal])).toEqual({
      value: ['s ok'],
      cachedAt: expect.any(Number)
    });
    b.unmount();
  });

  it('same race under a signal-stripping custom hash (consumer-app config): fresh request, one shared key', async () => {
    // The consumer app that hit this bug hashes with a signal-STRIPPING
    // custom hash, so a plain tuple and its trailing-signal twin collapse
    // into ONE key — a different collision surface than the default
    // stableHash's #sig placeholder. The abort-yield reads the RAW tuple,
    // so it must work identically here.
    const fetchData = vi.fn(abortAwareFetch);
    const cache = createMemoryCacheProvider<string[], [string, AbortSignal?]>({
      cacheTime: 60000,
      hash: (k) => stableHash(trimTrailingSignal(k))
    });
    let deleteEvents = 0;
    cache.subscribe!((e) => {
      if (e.type === 'delete') deleteEvents++;
    });
    let latest!: ArgsStatus;
    function Consumer() {
      const injectable = useInjectable(fetchData);
      useCache(injectable, cache);
      useRun(injectable, ARGS, {signal: true});
      latest = useArgsStatus(injectable, ARGS);
      return null;
    }

    const a = render(<Consumer />);
    a.unmount();
    const b = render(<Consumer />);

    await waitFor(() => {
      expect(latest.data).toEqual(['s ok']);
    });
    expect(latest.error).toBeUndefined();
    expect(fetchData).toHaveBeenCalledTimes(2);
    expect(deleteEvents).toBe(0);
    // Under the stripping hash the PLAIN tuple addresses the same entry.
    expect(cache.peek!(ARGS)).toEqual({
      value: ['s ok'],
      cachedAt: expect.any(Number)
    });
    b.unmount();
  });

  it("the creator's abort drops the slot but joiners keep their held promise to settlement", async () => {
    // Signal-IGNORING fetch: the abort drops the slot, but the shared
    // promise itself keeps pending — the joiner must still receive it.
    const resolvers: Array<(v: string) => void> = [];
    const fetchData = vi.fn(
      (_slug: string, _signal?: AbortSignal) =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const cache = createMemoryCacheProvider<
      string,
      Parameters<typeof fetchData>
    >({cacheTime: 60000});
    let deleteEvents = 0;
    cache.subscribe!((e) => {
      if (e.type === 'delete') deleteEvents++;
    });
    let latest!: ArgsStatus;
    // Both consumers run through useRun({signal: true}) — distinct signals,
    // one shared twin key (stableHash collapses every signal to one
    // placeholder). The first to mount CREATES the slot; the second JOINS.
    function SignalConsumer({read}: {read?: boolean}) {
      const injectable = useInjectable(fetchData);
      useCache(injectable, cache);
      useRun(injectable, ARGS, {signal: true});
      if (read) latest = useArgsStatus(injectable, ARGS);
      return null;
    }

    const a = render(<SignalConsumer />);
    const b = render(<SignalConsumer read />);
    // Let both wrapper chains run their microtask hops: one shared request,
    // B joined A's slot.
    await act(async () => {});
    expect(fetchData).toHaveBeenCalledTimes(1);
    expect(resolvers).toHaveLength(1);

    // The creator unmounts: its abort vacates the slot (a successor would
    // start fresh), but the JOINER's held promise is untouched — still
    // pending, still the one it subscribed to, and no delete event fired.
    a.unmount();
    expect(deleteEvents).toBe(0);

    await act(async () => {
      resolvers[0]!('v1');
    });
    await waitFor(() => {
      expect(latest.data).toBe('v1');
    });
    expect(latest.error).toBeUndefined();
    expect(deleteEvents).toBe(0);
    b.unmount();
  });

  it("a joiner's abort never drops a slot its own signal cannot cancel", async () => {
    const resolvers: Array<(v: string) => void> = [];
    const fetchData = vi.fn(
      (_slug: string, _signal?: AbortSignal) =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const cache = createMemoryCacheProvider<
      string,
      Parameters<typeof fetchData>
    >({cacheTime: 60000});
    let latest!: ArgsStatus;
    function SignalConsumer({read}: {read?: boolean}) {
      const injectable = useInjectable(fetchData);
      useCache(injectable, cache);
      useRun(injectable, ARGS, {signal: true});
      if (read) latest = useArgsStatus(injectable, ARGS);
      return null;
    }

    // A creates the slot; B joins the pending promise.
    const a = render(<SignalConsumer />);
    const b = render(<SignalConsumer />);
    await act(async () => {});
    expect(fetchData).toHaveBeenCalledTimes(1);

    // B unmounts: B's signal never reached the fetch (it joined, it did
    // not create), so the abort must NOT vacate the slot — a consumer
    // mounting in the same synchronous stack still JOINS the pending
    // request instead of double-fetching.
    b.unmount();
    const c = render(<SignalConsumer read />);
    await act(async () => {});
    expect(fetchData).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0]!('shared');
    });
    await waitFor(() => {
      expect(latest.data).toBe('shared');
    });
    expect(latest.error).toBeUndefined();
    a.unmount();
    c.unmount();
  });

  it('provider.load abort-yield: synchronous vacation, identity-guarded, silent, no resurrect', async () => {
    const provider = createMemoryCacheProvider<string, [string, AbortSignal?]>({
      cacheTime: 60000
    });
    const events: string[] = [];
    provider.subscribe!((e) => {
      events.push(e.type);
    });

    // A load whose args end in a signal: the slot is created, the yield
    // listener attached.
    const ac = new AbortController();
    let resolveFirst!: (v: string) => void;
    const first = provider.load!(
      ['k', ac.signal],
      () => new Promise<string>((r) => (resolveFirst = r))
    );
    let resolveJoiner!: (v: string) => void;
    const joinerFactory = vi.fn(
      () => new Promise<string>((r) => (resolveJoiner = r))
    );
    // A concurrent load with a DIFFERENT signal joins — its factory must
    // not run, and (below) its abort must not vacate the shared slot.
    const joinerAc = new AbortController();
    const joined = provider.load!(
      ['k', joinerAc.signal],
      vi.fn(async () => 'x')
    );
    expect(events).toEqual(['set']);

    // The joiner's abort: no-op — the slot survives. Proven by another
    // loader in the same synchronous stack: it still JOINS the pending
    // request (its factory does not run).
    joinerAc.abort();
    const thirdFactory = vi.fn(async () => 'x');
    provider.load!(['k', new AbortController().signal], thirdFactory);
    expect(thirdFactory).not.toHaveBeenCalled();

    // The creator's abort: the slot is vacated SYNCHRONOUSLY (no microtask
    // checkpoint since the abort), silently — no delete event, and not even
    // a set event beyond the load registration's own.
    const setEventsBefore = events.filter((t) => t === 'set').length;
    ac.abort();
    // A load in the same synchronous stack now runs its factory: the slot
    // was vacated by the abort listener, not by a settle microtask (none
    // has run — no await since the abort).
    let resolveSecond!: (v: string) => void;
    const successorFactory = vi.fn(
      () => new Promise<string>((r) => (resolveSecond = r))
    );
    const second = provider.load!(
      ['k', new AbortController().signal],
      successorFactory
    );
    expect(successorFactory).toHaveBeenCalledTimes(1);
    expect(events.filter((t) => t === 'delete')).toHaveLength(0);
    // Two set events since the abort: the drop's own (the slot vacation is
    // a provider-state change snapshot readers deserve to hear) and the
    // successor load's registration. Neither is a delete.
    expect(events.filter((t) => t === 'set').length).toBe(setEventsBefore + 2);

    // The successor settles; the dropped request settles LAST: the
    // identity guard keeps it from writing back over the successor's value.
    resolveSecond!('v2');
    await second;
    expect(provider.peek!(['k', new AbortController().signal])!.value).toBe(
      'v2'
    );
    resolveFirst('late-v1');
    await first;
    expect(provider.peek!(['k', new AbortController().signal])!.value).toBe(
      'v2'
    );
    // The shared promise never rejected; silence the joiner reference too.
    joined.catch(() => {});
  });

  it("StrictMode remount: the aborted first run yields its slot to the second run's fresh request", async () => {
    const fetchData = vi.fn(abortAwareFetch);
    const cache = createMemoryCacheProvider<
      string[],
      Parameters<typeof abortAwareFetch>
    >({cacheTime: 60000});
    let latest!: ArgsStatus;
    function Consumer() {
      const injectable = useInjectable(fetchData);
      useCache(injectable, cache);
      useRun(injectable, ARGS, {signal: true});
      latest = useArgsStatus(injectable, ARGS);
      return null;
    }

    render(
      <StrictMode>
        <Consumer />
      </StrictMode>
    );

    // StrictMode's mount→cleanup→mount fires the first signal's abort
    // synchronously; the slot yields, and the second run starts its own
    // request. The first was genuinely cancelled — joining its dead
    // promise would leave the app in a permanent AbortError state (the
    // bug this block regression-tests).
    await waitFor(() => {
      expect(latest.data).toEqual(['s ok']);
    });
    expect(latest.error).toBeUndefined();
    expect(fetchData).toHaveBeenCalledTimes(2);
  });
});

describe('useRun concurrent same-args sharing (no cache provider)', () => {
  // The no-cache counterpart of the provider `load` slot: two components
  // running the same injectable with the same logical args while a
  // request is pending share that one request (TanStack Query's default
  // request deduplication), while different args and sequential reruns
  // each issue their own call. An entry dies with its promise — a failed
  // call is retryable, a settled call is refetched.
  const ARGS_A: [string] = ['a'];
  const ARGS_B: [string] = ['b'];
  const latest: Record<string, ArgsStatus> = {};

  beforeEach(() => {
    for (const key of Object.keys(latest)) delete latest[key];
  });

  function makeDeferred() {
    const resolvers: Array<(v: string) => void> = [];
    const fetchData = vi.fn(
      (_key: string, _signal?: AbortSignal) =>
        // The signal is ignored on purpose: the promise pends until the
        // test resolves it, so a joiner keeps the shared outcome to
        // settlement even across the creator's abort.
        new Promise<string>((resolve) => resolvers.push(resolve))
    );
    return {fetchData, resolvers};
  }

  type Injectable = (key: string, signal?: AbortSignal) => Promise<string>;

  function Runner({
    injectable,
    args,
    signal,
    tag
  }: {
    injectable: Injectable;
    args: [string];
    signal?: boolean;
    tag?: string;
  }) {
    useRun(injectable, args, {signal});
    if (tag) latest[tag] = useArgsStatus(injectable, args);
    return null;
  }

  // Runners must receive ONE injectable through props: components each
  // calling useInjectable own separate chains and stores — separate
  // queries that are not shared, by design.
  function makeOwner(
    runners: (injectable: Injectable) => ReactNode
  ): ComponentType<{fetchData: Injectable}> {
    return function Owner({fetchData}) {
      const injectable = useInjectable(fetchData);
      return <>{runners(injectable)}</>;
    };
  }

  it('two concurrent runs of the same injectable and args share one request', async () => {
    const {fetchData, resolvers} = makeDeferred();
    const View = makeOwner((injectable) => (
      <>
        <Runner injectable={injectable} args={ARGS_A} tag='a' />
        <Runner injectable={injectable} args={ARGS_A} />
      </>
    ));
    render(<View fetchData={fetchData} />);
    await act(async () => {});
    expect(fetchData).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0]!('v1');
    });
    await waitFor(() => {
      expect(latest.a!.data).toBe('v1');
    });
    expect(latest.a!.loading).toBe(false);
    expect(latest.a!.error).toBeUndefined();
  });

  it('different args run independently', async () => {
    const {fetchData, resolvers} = makeDeferred();
    const View = makeOwner((injectable) => (
      <>
        <Runner injectable={injectable} args={ARGS_A} tag='a' />
        <Runner injectable={injectable} args={ARGS_B} tag='b' />
      </>
    ));
    render(<View fetchData={fetchData} />);
    await act(async () => {});
    expect(fetchData).toHaveBeenCalledTimes(2);
    expect(fetchData).toHaveBeenCalledWith('a');
    expect(fetchData).toHaveBeenCalledWith('b');

    await act(async () => {
      resolvers[0]!('va');
    });
    await waitFor(() => {
      expect(latest.a!.data).toBe('va');
    });
    // The shared result store keeps one provenance: while ['a'] holds the
    // display, ['b'] reads no data — and vice versa once ['b'] settles.
    expect(latest.b!.data).toBeUndefined();
    await act(async () => {
      resolvers[1]!('vb');
    });
    await waitFor(() => {
      expect(latest.b!.data).toBe('vb');
    });
  });

  it('a settled run is not shared: a sequential rerun fetches again', async () => {
    const {fetchData, resolvers} = makeDeferred();
    const View = makeOwner((injectable) => (
      <Runner injectable={injectable} args={ARGS_A} tag='a' />
    ));
    const first = render(<View fetchData={fetchData} />);
    await act(async () => {
      resolvers[0]!('first');
    });
    await waitFor(() => {
      expect(latest.a!.data).toBe('first');
    });
    first.unmount();

    const second = render(<View fetchData={fetchData} />);
    await act(async () => {});
    // the first entry died with its promise — the remount fetches fresh
    expect(fetchData).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolvers[1]!('second');
    });
    await waitFor(() => {
      expect(latest.a!.data).toBe('second');
    });
    second.unmount();
  });

  it('a plain run joins a {signal: true} run in flight', async () => {
    const {fetchData, resolvers} = makeDeferred();
    const View = makeOwner((injectable) => (
      <>
        <Runner injectable={injectable} args={ARGS_A} signal tag='a' />
        <Runner injectable={injectable} args={ARGS_A} />
      </>
    ));
    render(<View fetchData={fetchData} />);
    await act(async () => {});
    expect(fetchData).toHaveBeenCalledTimes(1);
    expect(fetchData).toHaveBeenCalledWith('a', expect.any(AbortSignal));

    await act(async () => {
      resolvers[0]!('shared');
    });
    await waitFor(() => {
      expect(latest.a!.data).toBe('shared');
    });
  });

  it('a joiner keeps the shared outcome after the creator unmounts', async () => {
    const {fetchData, resolvers} = makeDeferred();
    function Creator({injectable}: {injectable: Injectable}) {
      useRun(injectable, ARGS_A, {signal: true});
      return null;
    }
    function View({
      fetchData,
      withCreator
    }: {
      fetchData: Injectable;
      withCreator: boolean;
    }) {
      const injectable = useInjectable(fetchData);
      return (
        <>
          {withCreator && <Creator injectable={injectable} />}
          <Runner injectable={injectable} args={ARGS_A} tag='a' />
        </>
      );
    }
    const mounted = render(<View fetchData={fetchData} withCreator />);
    await act(async () => {});
    expect(fetchData).toHaveBeenCalledTimes(1);

    // The creator unmounts: its abort vacates the registry for FUTURE
    // runs, but the joiner already committed to the shared promise —
    // and the mock ignores the signal, so the outcome still settles.
    mounted.rerender(<View fetchData={fetchData} withCreator={false} />);
    await act(async () => {});
    expect(fetchData).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvers[0]!('kept');
    });
    await waitFor(() => {
      expect(latest.a!.data).toBe('kept');
    });
  });

  it('StrictMode without signal: the double effect still issues one request', async () => {
    const {fetchData, resolvers} = makeDeferred();
    const View = makeOwner((injectable) => (
      <Runner injectable={injectable} args={ARGS_A} tag='a' />
    ));
    render(
      <StrictMode>
        <View fetchData={fetchData} />
      </StrictMode>
    );
    await act(async () => {});
    expect(fetchData).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0]!('once');
    });
    await waitFor(() => {
      expect(latest.a!.data).toBe('once');
    });
  });

  it('StrictMode with {signal: true}: the aborted first run yields, the second fetches fresh', async () => {
    // A fetch with real abort semantics: the abort listener rejects
    // synchronously, exactly like the browser's fetch.
    const resolvers: Array<(v: string) => void> = [];
    const fetchData = vi.fn(
      (key: string, signal?: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          const onAbort = () =>
            reject(new DOMException('aborted', 'AbortError'));
          if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, {once: true});
          }
          resolvers.push(resolve);
        })
    );
    let latest!: ArgsStatus;
    function Consumer() {
      const injectable = useInjectable(fetchData);
      useRun(injectable, ARGS_A, {signal: true});
      latest = useArgsStatus(injectable, ARGS_A);
      return null;
    }
    render(
      <StrictMode>
        <Consumer />
      </StrictMode>
    );
    await act(async () => {});
    // The first run's abort must have vacated the registry synchronously:
    // the second effect run started a fresh request instead of joining
    // the dead promise (which would park the query in AbortError).
    expect(fetchData).toHaveBeenCalledTimes(2);
    expect(resolvers).toHaveLength(2);

    await act(async () => {
      resolvers[1]!('fresh');
    });
    await waitFor(() => {
      expect(latest.data).toBe('fresh');
    });
    expect(latest.error).toBeUndefined();
  });
});
