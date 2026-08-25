/**
 * Dedicated file for the `react-toolroom/devtools` entry: the panel is a
 * rendering component outside the async entry, so its tests do not belong
 * in test/async-hooks.test.ts or test/async.test.tsx (the async entry's
 * domains). The suite also wraps `subscribeInjectEvents` with a spy to
 * observe the unmount-unsubscribe path, which needs a module mock local to
 * this file.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {act, render, screen} from '@testing-library/react';
import {useInjectable, createMemoryCacheProvider} from '../src/async';
import {InjectDevTools, useInjectLog} from '../src/devtools';
import type {InjectLogEvent} from '../src/devtools';

// Wrap subscribeInjectEvents with a spy while delegating to the untouched
// real implementation, so tests can intercept the unsubscribe path.
const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  realSubscribe: (_fn: any, _handlers: any) => () => {}
}));

vi.mock('../src/async', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/async')>();
  mocks.realSubscribe = actual.subscribeInjectEvents;
  return {...actual, subscribeInjectEvents: mocks.subscribe};
});

mocks.subscribe.mockImplementation((fn: any, handlers: any) =>
  mocks.realSubscribe(fn, handlers)
);

describe('InjectDevTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records and renders settle events for success and failure', async () => {
    const fetchUser = vi.fn(async (id: number) => {
      if (id === 8) throw new Error('boom');
      return {id, name: `user-${id}`};
    });
    let call: any;
    function Host() {
      const fetchUsers = useInjectable(fetchUser);
      call = fetchUsers;
      return <InjectDevTools injectables={[fetchUsers]} />;
    }
    render(<Host />);

    // Empty state before any call settles.
    expect(
      screen.getByText(/no calls settled yet/i, {selector: 'p'})
    ).toBeTruthy();

    await act(async () => {
      await call(7);
    });

    expect(screen.getByText('ok', {selector: 'td'})).toBeTruthy();
    expect(screen.getByText('anonymous', {selector: 'td'})).toBeTruthy();
    expect(screen.getByText(/^\d+ms$/, {selector: 'td'})).toBeTruthy();
    expect(
      screen.getByText(/\[7\] → \{"id":7,"name":"user-7"\}/, {
        selector: 'td'
      })
    ).toBeTruthy();
    expect(
      screen.queryByText(/no calls settled yet/i, {selector: 'p'})
    ).toBeNull();

    await act(async () => {
      await call(8).catch(() => {});
    });

    expect(screen.getByText('error', {selector: 'td'})).toBeTruthy();
    expect(screen.getByText(/Error: boom/, {selector: 'td'})).toBeTruthy();
    // Table header plus both event rows.
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('keeps only the last `limit` events', async () => {
    const fetcher = vi.fn(async (n: number) => n);
    let call: any;
    function Host() {
      const fn = useInjectable(fetcher);
      call = fn;
      return <InjectDevTools injectables={[fn]} limit={1} />;
    }
    render(<Host />);

    await act(async () => {
      await call(1);
    });
    await act(async () => {
      await call(2);
    });

    // Header plus exactly one row — the newest call.
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText(/\[2\]/, {selector: 'td'})).toBeTruthy();
  });

  it('renders observed cache entries and truncates over-long values', async () => {
    const cache = createMemoryCacheProvider<string, [number]>();
    function Host() {
      const fn = useInjectable(async () => 'ok');
      return <InjectDevTools injectables={[fn]} caches={[cache]} />;
    }
    render(<Host />);

    await act(async () => {
      cache.set([1], 'v1');
    });
    expect(screen.getByText('v1', {selector: 'td'})).toBeTruthy();

    // A value past SUMMARY_LIMIT (80) is truncated with an ellipsis.
    await act(async () => {
      cache.set([2], 'x'.repeat(100));
    });
    const cell = screen.getByText('x'.repeat(79) + '…', {selector: 'td'});
    expect(cell.textContent).toHaveLength(80);
  });

  it('silently skips caches without a snapshot member', () => {
    function Host() {
      const fn = useInjectable(async () => 'ok');
      return <InjectDevTools injectables={[fn]} caches={[{} as any]} />;
    }
    render(<Host />);
    // the panel stays alive; no cache row was rendered from the bare object
    expect(
      screen.getByText(/no calls settled yet/i, {selector: 'p'})
    ).toBeTruthy();
    expect(screen.queryByText('v1', {selector: 'td'})).toBeNull();
  });

  it('unsubscribes on unmount and stops recording', async () => {
    const unsubscribe = vi.fn();
    mocks.subscribe.mockImplementationOnce((fn: any, handlers: any) => {
      const stop = mocks.realSubscribe(fn, handlers);
      return () => {
        unsubscribe();
        stop();
      };
    });

    const fetcher = vi.fn(async (n: number) => n);
    let call: any;
    function Host() {
      const fn = useInjectable(fetcher);
      call = fn;
      return <InjectDevTools injectables={[fn]} />;
    }
    const {unmount} = render(<Host />);

    await act(async () => {
      await call(1);
    });
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    // The detached observer neither records nor breaks the chain.
    await act(async () => {
      await call(2);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('renders observed cache entries and refreshes on mutation', () => {
    const cache = createMemoryCacheProvider<{id: number}, [number]>();
    render(<InjectDevTools injectables={[]} caches={[cache]} />);

    // Header-only table before any entry lands in the cache.
    expect(screen.getByText('Key', {selector: 'th'})).toBeTruthy();

    act(() => {
      cache.set([1], {id: 1});
    });

    // stableHash([1]) is '[number:1]'; the value cell goes through
    // summarize, the age cell is whole seconds since `cachedAt`.
    expect(screen.getByText('[number:1]', {selector: 'td'})).toBeTruthy();
    expect(screen.getByText('{"id":1}', {selector: 'td'})).toBeTruthy();
    expect(screen.getByText('0s', {selector: 'td'})).toBeTruthy();

    act(() => {
      cache.delete([1]);
    });

    // The subscribe-driven re-render pulled a fresh snapshot.
    expect(screen.queryByText('[number:1]', {selector: 'td'})).toBeNull();
    expect(screen.queryByText('{"id":1}', {selector: 'td'})).toBeNull();
  });

  it('skips caches without snapshot and renders without errors', () => {
    render(<InjectDevTools injectables={[]} caches={[{} as any]} />);

    // No cache table headers, and the panel is otherwise intact.
    expect(screen.queryByText('Key', {selector: 'th'})).toBeNull();
    expect(
      screen.getByText(/no calls settled yet/i, {selector: 'p'})
    ).toBeTruthy();
  });
});

describe('useInjectLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes events and clear for custom panels, trimmed to limit', async () => {
    const fetcher = vi.fn(async (n: number) => n * 2);
    let call: any;
    let latest!: {events: InjectLogEvent[]; clear: () => void};
    function Probe({fn}: {fn: any}) {
      latest = useInjectLog(fn, 2);
      return null;
    }
    function Host() {
      const fn = useInjectable(fetcher);
      call = fn;
      return <Probe fn={fn} />;
    }
    render(<Host />);

    await act(async () => {
      await call(1);
    });
    await act(async () => {
      await call(2);
    });
    await act(async () => {
      await call(3);
    });

    // limit=2 keeps only the last two of the three calls, in order.
    expect(latest.events.map((event) => event.args)).toEqual([[2], [3]]);
    const [first, second] = latest.events;
    expect(first.result).toBe(4);
    expect(first.error).toBeUndefined();
    expect(first.name).toBe('anonymous');
    expect(typeof first.duration).toBe('number');
    expect(typeof first.at).toBe('number');
    // Monotonic sequence numbers survive trimming (stable React keys).
    expect(first.seq).toBeLessThan(second.seq);

    await act(async () => {
      latest.clear();
    });
    expect(latest.events).toEqual([]);
  });

  it('records rejections with error and without result', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('network down');
    });
    let call: any;
    let latest!: {events: InjectLogEvent[]; clear: () => void};
    function Probe({fn}: {fn: any}) {
      latest = useInjectLog(fn);
      return null;
    }
    function Host() {
      const fn = useInjectable(fetcher);
      call = fn;
      return <Probe fn={fn} />;
    }
    render(<Host />);

    await act(async () => {
      await call().catch(() => {});
    });

    expect(latest.events).toHaveLength(1);
    expect(latest.events[0].error).toBeInstanceOf(Error);
    expect(latest.events[0].result).toBeUndefined();
  });
});
