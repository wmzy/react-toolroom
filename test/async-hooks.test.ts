import {describe, it, expect, vi} from 'vitest';
import {act, fireEvent, render, screen} from '@testing-library/react';
import {createElement} from 'react';
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
  getInjectContext,
  useInject,
  usePolling,
  useFocusRevalidate,
  useOptimistic,
  useInfinite,
  isInjectable,
  subscribeInjectEvents
} from '../src/async';
import {useLoadingFn} from '../src/async/base';
import {addWrapper, useInjectBefore} from '../src/async/inject';

describe('async hooks exports', () => {
  it('should export useRun', () => {
    expect(useRun).toBeDefined();
    expect(typeof useRun).toBe('function');
  });

  it('should export useInjectable', () => {
    expect(useInjectable).toBeDefined();
    expect(typeof useInjectable).toBe('function');
  });

  it('should export createMemoryCacheProvider', () => {
    expect(createMemoryCacheProvider).toBeDefined();
    expect(typeof createMemoryCacheProvider).toBe('function');
  });

  it('should export useResult', () => {
    expect(useResult).toBeDefined();
    expect(typeof useResult).toBe('function');
  });

  it('should export useSuspenseResult', () => {
    expect(useSuspenseResult).toBeDefined();
    expect(typeof useSuspenseResult).toBe('function');
  });

  it('should export useLoading', () => {
    expect(useLoading).toBeDefined();
    expect(typeof useLoading).toBe('function');
  });

  it('should export useInitialLoading', () => {
    expect(useInitialLoading).toBeDefined();
    expect(typeof useInitialLoading).toBe('function');
  });

  it('should export useError', () => {
    expect(useError).toBeDefined();
    expect(typeof useError).toBe('function');
  });

  it('should export useFailureCount', () => {
    expect(useFailureCount).toBeDefined();
    expect(typeof useFailureCount).toBe('function');
  });

  it('should export useCatch', () => {
    expect(useCatch).toBeDefined();
    expect(typeof useCatch).toBe('function');
  });

  it('should export useFinally', () => {
    expect(useFinally).toBeDefined();
    expect(typeof useFinally).toBe('function');
  });

  it('should export useRetry', () => {
    expect(useRetry).toBeDefined();
    expect(typeof useRetry).toBe('function');
  });

  it('should export useCache', () => {
    expect(useCache).toBeDefined();
    expect(typeof useCache).toBe('function');
  });

  it('should export useInvalidate', () => {
    expect(useInvalidate).toBeDefined();
    expect(typeof useInvalidate).toBe('function');
  });

  it('should export getInjectContext', () => {
    expect(getInjectContext).toBeDefined();
    expect(typeof getInjectContext).toBe('function');
  });

  it('should export useInject', () => {
    expect(useInject).toBeDefined();
    expect(typeof useInject).toBe('function');
  });

  it('should export isInjectable', () => {
    expect(isInjectable).toBeDefined();
    expect(typeof isInjectable).toBe('function');
  });

  it('should export usePolling', () => {
    expect(usePolling).toBeDefined();
    expect(typeof usePolling).toBe('function');
  });

  it('should export useFocusRevalidate', () => {
    expect(useFocusRevalidate).toBeDefined();
    expect(typeof useFocusRevalidate).toBe('function');
  });

  it('should export subscribeInjectEvents', () => {
    expect(subscribeInjectEvents).toBeDefined();
    expect(typeof subscribeInjectEvents).toBe('function');
  });
});

describe('async/base exports', () => {
  it('should export useLoadingFn', () => {
    expect(useLoadingFn).toBeDefined();
    expect(typeof useLoadingFn).toBe('function');
  });
});

describe('async/inject exports', () => {
  it('should export useInjectBefore', () => {
    expect(useInjectBefore).toBeDefined();
    expect(typeof useInjectBefore).toBe('function');
  });

  it('should export addWrapper', () => {
    expect(addWrapper).toBeDefined();
    expect(typeof addWrapper).toBe('function');
  });

  // Scenario: caller passes a plain (non-useInjectable) function — the WeakMap
  // lookup misses and must fail with a clear error instead of an obscure
  // "Cannot read properties of undefined" TypeError.
  it('should throw a clear error when getInjectContext gets a plain function', () => {
    const plain = () => 'not injectable';
    expect(() => getInjectContext(plain)).toThrow(/useInjectable/);
  });

  it('should throw a clear error when useInject gets a plain function', () => {
    const plain = () => 'not injectable';
    expect(() => useInject(plain, (f) => f)).toThrow(/useInjectable/);
  });

  it('should return false for a plain function', () => {
    expect(isInjectable(() => 'plain')).toBe(false);
  });

  it('should return true for a function returned by useInjectable', () => {
    let injectable: () => any;
    function TestComponent() {
      injectable = useInjectable(() => 'ok');
      return null;
    }

    render(createElement(TestComponent));
    expect(isInjectable(injectable!)).toBe(true);
  });
});

describe('useRun signal option', () => {
  it('should pass an AbortSignal as trailing argument and abort it when dependencies change', () => {
    const received: {id: number; signal: AbortSignal}[] = [];

    function TestComponent({id}: {id: number}) {
      const injectable = useInjectable((id: number, signal: AbortSignal) => {
        received.push({id, signal});
        return Promise.resolve(`ok ${id}`);
      });
      useRun(injectable, [id], {signal: true});
      return null;
    }

    const {rerender} = render(createElement(TestComponent, {id: 1}));
    expect(received.length).toBe(1);
    expect(received[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(received[0]!.id).toBe(1);
    expect(received[0]!.signal.aborted).toBe(false);

    rerender(createElement(TestComponent, {id: 2}));
    expect(received.length).toBe(2);
    expect(received[1]!.id).toBe(2);
    // dependency change aborted the previous run's signal; the new one is live
    expect(received[0]!.signal.aborted).toBe(true);
    expect(received[1]!.signal.aborted).toBe(false);
  });

  it('should keep passing plain arguments through when signal is enabled', () => {
    const calls: any[][] = [];

    function TestComponent({id}: {id: number}) {
      const injectable = useInjectable((id: number, signal: AbortSignal) => {
        calls.push([id, signal]);
        return Promise.resolve('ok');
      });
      useRun(injectable, [id], {signal: true});
      return null;
    }

    render(createElement(TestComponent, {id: 7}));
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe(7);
    expect(calls[0]![1]).toBeInstanceOf(AbortSignal);
  });

  it('should expose the signal on the per-call context of injected wrappers', () => {
    const seen: AbortSignal[] = [];

    function TestComponent() {
      const injectable = useInjectable(async () => 'ok');
      useInject(
        injectable,
        (f: any, callContext: any) =>
          ((...args: any[]) => {
            if (callContext.signal) seen.push(callContext.signal);
            return f(...args);
          }) as any
      );
      useRun(injectable, [], {signal: true});
      return null;
    }

    render(createElement(TestComponent));
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('useInitialLoading', () => {
  it('should be true only until the first result arrives', async () => {
    const resolvers: ((v: string) => void)[] = [];
    const fetchData = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    function TestComponent() {
      const injectable = useInjectable(fetchData);
      const result = useResult(injectable);
      const initialLoading = useInitialLoading(injectable);
      useRun(injectable, []);

      return createElement(
        'div',
        null,
        createElement('span', null, result ?? 'no result'),
        createElement('span', null, initialLoading ? 'initial' : 'ready'),
        createElement(
          'button',
          {type: 'button', onClick: () => injectable()},
          'refetch'
        )
      );
    }

    render(createElement(TestComponent));
    // no result yet while the first call is in flight
    expect(screen.getByText('initial')).toBeDefined();
    expect(screen.getByText('no result')).toBeDefined();

    await act(async () => {
      resolvers[0]!('first');
    });
    expect(screen.getByText('first')).toBeDefined();
    expect(screen.getByText('ready')).toBeDefined();

    // a later background request no longer counts as initial loading
    await act(async () => {
      fireEvent.click(screen.getByText('refetch'));
    });
    expect(fetchData).toHaveBeenCalledTimes(2);
    expect(screen.getByText('ready')).toBeDefined();
    expect(screen.queryByText('initial')).toBeNull();
  });
});

describe('usePolling', () => {
  // jsdom keeps `hidden` as a getter on Document.prototype; defining an own
  // property shadows it and `delete` restores the prototype getter.
  const setHidden = (hidden: boolean) =>
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden
    });
  const restoreHidden = () => delete (document as any).hidden;

  it('should call the injectable without arguments on every tick', async () => {
    vi.useFakeTimers();
    try {
      const fetchData = vi.fn(async () => 'ok');
      function TestComponent() {
        const injectable = useInjectable(fetchData);
        usePolling(injectable, 1000);
        return null;
      }
      render(createElement(TestComponent));
      expect(fetchData).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchData).toHaveBeenCalledTimes(5);
      expect(fetchData.mock.calls[0]).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should stop polling after unmount', async () => {
    vi.useFakeTimers();
    try {
      const fetchData = vi.fn(async () => 'ok');
      function TestComponent() {
        const injectable = useInjectable(fetchData);
        usePolling(injectable, 1000);
        return null;
      }
      const {unmount} = render(createElement(TestComponent));
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchData).toHaveBeenCalledTimes(1);
      unmount();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchData).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should skip ticks while the previous call is pending', async () => {
    vi.useFakeTimers();
    try {
      const resolvers: (() => void)[] = [];
      const fetchData = vi.fn(
        () => new Promise<void>((resolve) => resolvers.push(resolve))
      );
      function TestComponent() {
        const injectable = useInjectable(fetchData);
        usePolling(injectable, 1000);
        return null;
      }
      render(createElement(TestComponent));
      await vi.advanceTimersByTimeAsync(4000);
      // one call is pending, so ticks 2-4 are skipped instead of piling up
      expect(fetchData).toHaveBeenCalledTimes(1);
      // once the call settles, polling resumes on the next tick
      resolvers[0]!();
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchData).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should restart the timer when the interval changes', async () => {
    vi.useFakeTimers();
    try {
      const fetchData = vi.fn(async () => 'ok');
      function TestComponent({interval}: {interval: number}) {
        const injectable = useInjectable(fetchData);
        usePolling(injectable, interval);
        return null;
      }
      const {rerender} = render(createElement(TestComponent, {interval: 1000}));
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchData).toHaveBeenCalledTimes(1);
      rerender(createElement(TestComponent, {interval: 3000}));
      // the old 1000ms cadence is gone
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchData).toHaveBeenCalledTimes(1);
      // the new cadence fires 3000ms after the change
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchData).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should pause while the document is hidden', async () => {
    vi.useFakeTimers();
    try {
      const fetchData = vi.fn(async () => 'ok');
      function TestComponent() {
        const injectable = useInjectable(fetchData);
        usePolling(injectable, 1000);
        return null;
      }
      setHidden(true);
      render(createElement(TestComponent));
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchData).toHaveBeenCalledTimes(0);
      setHidden(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchData).toHaveBeenCalledTimes(1);
    } finally {
      restoreHidden();
      vi.useRealTimers();
    }
  });

  it('should keep polling while hidden when whenHidden is true', async () => {
    vi.useFakeTimers();
    try {
      const fetchData = vi.fn(async () => 'ok');
      function TestComponent() {
        const injectable = useInjectable(fetchData);
        usePolling(injectable, 1000, {whenHidden: true});
        return null;
      }
      setHidden(true);
      render(createElement(TestComponent));
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchData).toHaveBeenCalledTimes(2);
    } finally {
      restoreHidden();
      vi.useRealTimers();
    }
  });
});

describe('useFocusRevalidate', () => {
  const setHidden = (hidden: boolean) =>
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden
    });
  const restoreHidden = () => delete (document as any).hidden;

  it('should revalidate on window focus', () => {
    const fetchData = vi.fn(async () => 'ok');
    function TestComponent() {
      const injectable = useInjectable(fetchData);
      useFocusRevalidate(injectable);
      return null;
    }
    render(createElement(TestComponent));
    expect(fetchData).toHaveBeenCalledTimes(0);
    fireEvent(window, new Event('focus'));
    expect(fetchData).toHaveBeenCalledTimes(1);
    // no throttle by default: every focus event revalidates
    fireEvent(window, new Event('focus'));
    expect(fetchData).toHaveBeenCalledTimes(2);
  });

  it('should revalidate when the document becomes visible', () => {
    const fetchData = vi.fn(async () => 'ok');
    function TestComponent() {
      const injectable = useInjectable(fetchData);
      useFocusRevalidate(injectable);
      return null;
    }
    render(createElement(TestComponent));
    try {
      setHidden(false);
      fireEvent(document, new Event('visibilitychange'));
      expect(fetchData).toHaveBeenCalledTimes(1);
      // turning hidden does not revalidate
      setHidden(true);
      fireEvent(document, new Event('visibilitychange'));
      expect(fetchData).toHaveBeenCalledTimes(1);
    } finally {
      restoreHidden();
    }
  });

  it('should throttle focus events within the window', () => {
    const fetchData = vi.fn(async () => 'ok');
    function TestComponent() {
      const injectable = useInjectable(fetchData);
      useFocusRevalidate(injectable, {interval: 5000});
      return null;
    }
    render(createElement(TestComponent));
    fireEvent(window, new Event('focus'));
    fireEvent(window, new Event('focus'));
    fireEvent(window, new Event('focus'));
    expect(fetchData).toHaveBeenCalledTimes(1);
  });

  it('should stop revalidating after unmount', () => {
    const fetchData = vi.fn(async () => 'ok');
    function TestComponent() {
      const injectable = useInjectable(fetchData);
      useFocusRevalidate(injectable);
      return null;
    }
    const {unmount} = render(createElement(TestComponent));
    unmount();
    fireEvent(window, new Event('focus'));
    fireEvent(document, new Event('visibilitychange'));
    expect(fetchData).toHaveBeenCalledTimes(0);
  });
});

describe('subscribeInjectEvents', () => {
  // The API is hook-free, but its input must come from useInjectable, so a
  // tiny component renders the injectable and hands it to the test.
  function renderInjectable<AF extends (...args: any[]) => Promise<any>>(
    fn: AF
  ): AF {
    let injectable!: AF;
    function TestComponent() {
      injectable = useInjectable(fn);
      return null;
    }
    render(createElement(TestComponent));
    return injectable;
  }

  it('should emit onCall with args and onSettle with result and duration', async () => {
    const injectable = renderInjectable(async (x: number) => `ok ${x}`);
    const calls: number[][] = [];
    const settles: any[] = [];
    const unsubscribe = subscribeInjectEvents(injectable, {
      onCall: (args) => calls.push([...args]),
      onSettle: (info) => settles.push(info)
    });

    let resolved!: string;
    await act(async () => {
      resolved = await injectable(7);
    });

    expect(resolved).toBe('ok 7');
    expect(calls).toEqual([[7]]);
    expect(settles.length).toBe(1);
    expect(settles[0].args).toEqual([7]);
    expect(settles[0].result).toBe('ok 7');
    expect(settles[0].error).toBeUndefined();
    expect(settles[0].duration).toBeGreaterThanOrEqual(0);

    unsubscribe();
  });

  it('should report a rejection on the error field', async () => {
    const injectable = renderInjectable(async () => {
      throw new Error('boom');
    });
    const settles: any[] = [];
    const unsubscribe = subscribeInjectEvents(injectable, {
      onSettle: (info) => settles.push(info)
    });

    await act(async () => {
      await expect(injectable()).rejects.toThrow('boom');
    });

    expect(settles.length).toBe(1);
    expect(settles[0].error).toBeInstanceOf(Error);
    expect(settles[0].error.message).toBe('boom');
    expect(settles[0].result).toBeUndefined();
    expect(settles[0].duration).toBeGreaterThanOrEqual(0);

    unsubscribe();
  });

  it('should stop emitting after unsubscribing', async () => {
    const injectable = renderInjectable(async () => 'ok');
    const calls: any[][] = [];
    const settles: any[] = [];
    const unsubscribe = subscribeInjectEvents(injectable, {
      onCall: (args) => calls.push(args),
      onSettle: (info) => settles.push(info)
    });

    await act(async () => {
      await injectable();
    });
    expect(calls.length).toBe(1);
    expect(settles.length).toBe(1);

    unsubscribe();
    await act(async () => {
      await injectable();
    });
    // neither handler fires once the observer is removed
    expect(calls.length).toBe(1);
    expect(settles.length).toBe(1);
  });

  it('should observe from outside wrappers registered earlier', async () => {
    let injectable!: () => Promise<string>;
    function TestComponent() {
      injectable = useInjectable(async () => 'ok');
      // Registered during render, i.e. before the observer below subscribes.
      useInject(
        injectable,
        (f: any) =>
          ((...args: any[]) =>
            new Promise((resolve) =>
              setTimeout(() => resolve(f(...args)), 50)
            )) as any
      );
      return null;
    }
    render(createElement(TestComponent));

    const settles: any[] = [];
    const unsubscribe = subscribeInjectEvents(injectable, {
      onSettle: (info) => settles.push(info)
    });

    await act(async () => {
      await injectable();
    });

    // The observer is the outermost layer, so its duration spans the whole
    // chain underneath — including the hook-registered wrapper's 50ms sleep.
    expect(settles.length).toBe(1);
    expect(settles[0].result).toBe('ok');
    expect(settles[0].duration).toBeGreaterThanOrEqual(50);

    unsubscribe();
  });
});

describe('useOptimistic', () => {
  it('should publish the optimistic snapshot and let the real result overwrite it', async () => {
    const resolvers: (() => void)[] = [];
    const saveName = vi.fn(
      (name: string) =>
        new Promise<string>((resolve) =>
          resolvers.push(() => resolve(`saved:${name}`))
        )
    );

    function TestComponent() {
      const injectable = useInjectable(saveName);
      useOptimistic(
        injectable,
        (draft, name) => `saving:${name} (was ${draft ?? 'none'})`
      );
      const result = useResult(injectable);
      return createElement(
        'div',
        null,
        createElement('span', null, result ?? 'nothing'),
        createElement(
          'button',
          {type: 'button', onClick: () => void injectable('alice')},
          'save'
        )
      );
    }

    render(createElement(TestComponent));
    expect(screen.getByText('nothing')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByText('save'));
    });
    // the optimistic snapshot is on display before the promise settles
    expect(screen.getByText('saving:alice (was none)')).toBeDefined();
    expect(saveName).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0]!();
    });
    // the real result overwrote the optimistic snapshot
    expect(screen.getByText('saved:alice')).toBeDefined();
  });

  it('should roll back to the pre-call snapshot on failure while the error keeps flowing', async () => {
    const resolvers: (() => void)[] = [];
    const saveName = (name: string) =>
      new Promise<string>((resolve, reject) =>
        resolvers.push(() =>
          name === 'bob' ? resolve(`saved:${name}`) : reject(new Error('boom'))
        )
      );

    function TestComponent() {
      const injectable = useInjectable(saveName);
      useOptimistic(
        injectable,
        (draft, name) => `saving:${name} (was ${draft ?? 'none'})`
      );
      const result = useResult(injectable);
      const error = useError<Error>(injectable);
      return createElement(
        'div',
        null,
        createElement('span', null, result ?? 'nothing'),
        createElement('span', null, error ? error.message : 'no error'),
        createElement(
          'button',
          {type: 'button', onClick: () => void injectable('bob')},
          'ok'
        ),
        createElement(
          'button',
          {
            type: 'button',
            onClick: () => injectable('alice').catch(() => {})
          },
          'fail'
        )
      );
    }

    render(createElement(TestComponent));
    // establish the pre-call snapshot with a successful save
    await act(async () => {
      fireEvent.click(screen.getByText('ok'));
    });
    await act(async () => {
      resolvers[0]!();
    });
    expect(screen.getByText('saved:bob')).toBeDefined();

    // the failing call first shows its optimistic snapshot…
    await act(async () => {
      fireEvent.click(screen.getByText('fail'));
    });
    expect(screen.getByText('saving:alice (was saved:bob)')).toBeDefined();

    // …then rolls back to the pre-call snapshot, and useError still fired
    await act(async () => {
      resolvers[1]!();
    });
    expect(screen.getByText('saved:bob')).toBeDefined();
    expect(screen.getByText('boom')).toBeDefined();
  });
});

describe('useInfinite', () => {
  const nextCursor = (last: string, all: string[]) =>
    all.length < 2 ? Number(last.slice(1)) + 1 : undefined;

  it('should aggregate pages, expose the paging flags and stop at undefined', async () => {
    const resolvers: (() => void)[] = [];
    const fetchPage = vi.fn(
      (cursor: number) =>
        new Promise<string>((resolve) =>
          resolvers.push(() => resolve(`p${cursor}`))
        )
    );

    function TestComponent() {
      const fetchPages = useInjectable(fetchPage);
      const {pages, fetchNextPage, isFetchingNextPage, hasNextPage} =
        useInfinite(fetchPages, {getNextPageParam: nextCursor});
      useRun(fetchPages, [0]);
      return createElement(
        'div',
        null,
        createElement('span', null, `pages:${pages.join(',')}`),
        createElement('span', null, `hasNext:${String(hasNextPage)}`),
        createElement('span', null, `fetching:${String(isFetchingNextPage)}`),
        createElement(
          'button',
          {type: 'button', onClick: () => void fetchNextPage()},
          'more'
        )
      );
    }

    render(createElement(TestComponent));
    // first page in flight: no pages yet, and nothing to continue from
    expect(screen.getByText('pages:')).toBeDefined();

    await act(async () => {
      resolvers[0]!();
    });
    expect(screen.getByText('pages:p0')).toBeDefined();
    expect(screen.getByText('hasNext:true')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByText('more'));
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[1]).toEqual([1]);
    expect(screen.getByText('fetching:true')).toBeDefined();
    expect(screen.getByText('pages:p0')).toBeDefined();

    await act(async () => {
      resolvers[1]!();
    });
    expect(screen.getByText('pages:p0,p1')).toBeDefined();
    expect(screen.getByText('hasNext:false')).toBeDefined();
    expect(screen.getByText('fetching:false')).toBeDefined();
  });

  it('should reset pages when the fetcher is re-run directly', async () => {
    const resolvers: (() => void)[] = [];
    const fetchPage = (cursor: number) =>
      new Promise<string>((resolve) =>
        resolvers.push(() => resolve(`p${cursor}`))
      );

    function TestComponent() {
      const fetchPages = useInjectable(fetchPage);
      const {pages, fetchNextPage} = useInfinite(fetchPages, {
        getNextPageParam: nextCursor
      });
      useRun(fetchPages, [0]);
      return createElement(
        'div',
        null,
        createElement('span', null, `pages:${pages.join(',')}`),
        createElement(
          'button',
          {type: 'button', onClick: () => void fetchNextPage()},
          'more'
        ),
        createElement(
          'button',
          {type: 'button', onClick: () => void fetchPages(0)},
          'restart'
        )
      );
    }

    render(createElement(TestComponent));
    await act(async () => {
      resolvers[0]!();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('more'));
    });
    await act(async () => {
      resolvers[1]!();
    });
    expect(screen.getByText('pages:p0,p1')).toBeDefined();

    // a direct call (what a useRun rerun does) resets the aggregation
    await act(async () => {
      fireEvent.click(screen.getByText('restart'));
    });
    expect(screen.getByText('pages:p0,p1')).toBeDefined();
    await act(async () => {
      resolvers[2]!();
    });
    expect(screen.getByText('pages:p0')).toBeDefined();
  });
});

describe('useRetry preset options', () => {
  it('should retry up to `retries` times and then resolve with success', async () => {
    let calls = 0;
    const flaky = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          calls++;
          if (calls < 3) reject(new Error(`fail ${calls}`));
          else resolve('ok');
        })
    );

    function TestComponent() {
      const injectable = useInjectable(flaky);
      useRetry(injectable, {retries: 2, backoff: () => 0});
      const result = useResult(injectable);
      return createElement(
        'div',
        null,
        createElement('span', null, result ?? 'nothing'),
        createElement(
          'button',
          {type: 'button', onClick: () => void injectable()},
          'run'
        )
      );
    }

    render(createElement(TestComponent));
    await act(async () => {
      fireEvent.click(screen.getByText('run'));
      // let the zero-backoff retry microtask chain settle
      await new Promise((r) => setTimeout(r, 0));
    });
    // 1 initial attempt + 2 retries
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(screen.getByText('ok')).toBeDefined();
  });

  it('should stop after `retries` retries and surface the error', async () => {
    const flaky = vi.fn(async () => {
      throw new Error('always fails');
    });

    function TestComponent() {
      const injectable = useInjectable(flaky);
      useRetry(injectable, {retries: 1, backoff: () => 0});
      const error = useError<Error>(injectable);
      return createElement(
        'div',
        null,
        createElement('span', null, error ? error.message : 'no error'),
        createElement(
          'button',
          {type: 'button', onClick: () => injectable().catch(() => {})},
          'run'
        )
      );
    }

    render(createElement(TestComponent));
    await act(async () => {
      fireEvent.click(screen.getByText('run'));
      await new Promise((r) => setTimeout(r, 0));
    });
    // 1 initial attempt + 1 retry, then the rejection wins
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(screen.getByText('always fails')).toBeDefined();
  });
});

describe('useRun inline-args dev warning', () => {
  function TestComponent({id}: {id: number}) {
    const injectable = useInjectable(async (query: {id: number}) => query.id);
    // a fresh object literal on every render: the classic footgun
    useRun(injectable, [{id}]);
    return null;
  }

  it('should warn when the args reference changed but stableHash is equal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const {rerender} = render(createElement(TestComponent, {id: 1}));
      expect(warn).not.toHaveBeenCalled();
      // same structure, new reference → the effect would re-run for nothing
      rerender(createElement(TestComponent, {id: 1}));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('stableHash');
      // a real change is never warned about
      rerender(createElement(TestComponent, {id: 2}));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('should stay silent when the hash option is in use', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      function Hashed() {
        const injectable = useInjectable(
          async (query: {id: number}) => query.id
        );
        useRun(injectable, [{id: 1}], {hash: (a) => JSON.stringify(a)});
        return null;
      }
      const {rerender} = render(createElement(Hashed));
      rerender(createElement(Hashed));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('should stay silent in production mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The guard reads process.env.NODE_ENV live, exactly what bundlers
    // replace statically in real production builds.
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const {rerender} = render(createElement(TestComponent, {id: 1}));
      rerender(createElement(TestComponent, {id: 1}));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      warn.mockRestore();
    }
  });
});
