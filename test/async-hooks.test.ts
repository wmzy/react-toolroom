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
