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
import {StrictMode} from 'react';
import {
  useInjectable,
  useRun,
  useResult,
  createMemoryCacheProvider,
  stableHash
} from '../src/async';
import {
  getNamedInjectables,
  subscribeNamedInjectables
} from '../src/async/inject';
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

  it('Remove deletes exactly its entry through its structural key', async () => {
    const cache = createMemoryCacheProvider<string, [number]>();
    function Host() {
      const fn = useInjectable(async () => 'ok');
      return <InjectDevTools injectables={[fn]} caches={[cache]} />;
    }
    render(<Host />);

    await act(async () => {
      cache.set([1], 'v1');
      cache.set([2], 'v2');
    });
    expect(cache.snapshot!()).toHaveLength(2);

    // Each row renders its own Remove button, addressed by its key.
    const remove1 = screen.getByRole('button', {name: 'Remove [number:1]'});
    await act(async () => {
      remove1.click();
    });

    // Only entry [1] is gone — Remove addresses exactly one entry through
    // the hashed key its snapshot row carries (deleteKey).
    expect(cache.snapshot!()).toHaveLength(1);
    expect(cache.peek!([1])).toBeUndefined();
    expect(cache.peek!([2])!.value).toBe('v2');
    // The subscribe-driven re-render dropped the row.
    expect(screen.queryByText('v1', {selector: 'td'})).toBeNull();
    expect(screen.getByText('v2', {selector: 'td'})).toBeTruthy();
  });

  it('Remove deletes exactly its entry even after in-place args mutation (T4 root fix)', async () => {
    const cache = createMemoryCacheProvider<string, any[]>();
    function Host() {
      const fn = useInjectable(async (x: any) => x);
      return <InjectDevTools injectables={[fn]} caches={[cache]} />;
    }
    render(<Host />);

    // set() stores the CALLER's array by reference; the caller then
    // mutates it in place (a reused args buffer gaining an element) — the
    // stored tuple's re-hash drifts off the entry's recorded key. This is
    // the T4 scenario: 0.14.0 removed nothing silently, the interim fix
    // flagged the row 'remove missed', and deleteKey now removes exactly.
    const args = [1];
    await act(async () => {
      cache.set(args, 'v1');
      cache.set([9], 'v9');
    });
    args.push(2);

    const remove = screen.getByRole('button', {name: 'Remove [number:1]'});
    await act(async () => {
      remove.click();
    });

    // deleteKey addressed the row by the hashed key recorded at write
    // time: the entry is gone despite the tuple mutation, neighbors are
    // untouched, and no flag ever shows.
    expect(cache.peek!([1])).toBeUndefined();
    expect(cache.snapshot!()).toHaveLength(1);
    expect(cache.peek!([9])!.value).toBe('v9');
    expect(screen.queryByText(/remove missed/i)).toBeNull();
    expect(screen.queryByText('v1', {selector: 'td'})).toBeNull();
  });

  it('Remove falls back to args re-hashing — and flags a miss — without deleteKey', async () => {
    // The pre-deleteKey addressing path, kept for providers that never
    // implement it: the row's raw tuple is re-hashed, so a tuple mutated
    // in place after set misses and the row flags itself instead of
    // failing quietly.
    const rows = [{key: 'k1', value: 'v1', cachedAt: 0, args: [1]}];
    const legacy = {
      snapshot: () => rows,
      subscribe: () => () => {},
      // Re-hashes the (drifted) tuple — misses by construction here.
      delete: () => {},
      clear: () => {}
    };
    function Host() {
      const fn = useInjectable(async () => 'ok');
      return <InjectDevTools injectables={[fn]} caches={[legacy]} />;
    }
    render(<Host />);

    const remove = screen.getByRole('button', {name: 'Remove k1'});
    await act(async () => {
      remove.click();
    });

    // The fallback verified against the snapshot: the row provably
    // survived and says so — the panel never lies about what it shows.
    expect(rows).toHaveLength(1);
    expect(screen.getByText(/remove missed/i)).toBeTruthy();
  });

  it('Remove also addresses hydrated rows that carry no raw args tuple', async () => {
    const cache = createMemoryCacheProvider<string, [number]>();
    // hydrate() mutates silently (no set event), so prime the cache before
    // the panel mounts — the first render pulls snapshot() directly.
    const key = stableHash([1]);
    cache.hydrate!({[key]: ['v1', 0]});
    function Host() {
      const fn = useInjectable(async () => 'ok');
      return <InjectDevTools injectables={[fn]} caches={[cache]} />;
    }
    render(<Host />);

    // The hydrated row carries no args — before deleteKey it rendered no
    // Remove button at all.
    const remove = screen.getByRole('button', {name: `Remove ${key}`});
    await act(async () => {
      remove.click();
    });
    expect(cache.snapshot!()).toEqual([]);
    expect(screen.queryByText('v1', {selector: 'td'})).toBeNull();
  });

  it('Invalidate clears the whole cache through the provider primitive', async () => {
    const cache = createMemoryCacheProvider<string, [number]>();
    const deleted: any[][] = [];
    cache.subscribe?.((e) => {
      if (e.type === 'delete') deleted.push(...e.deleted);
    });
    function Host() {
      const fn = useInjectable(async () => 'ok');
      return <InjectDevTools injectables={[fn]} caches={[cache]} />;
    }
    render(<Host />);

    await act(async () => {
      cache.set([1], 'v1');
      cache.set([2], 'v2');
    });

    const invalidate = screen.getAllByRole('button', {name: /invalidate/i});
    // One Invalidate button per cache row group — both address the same
    // provider; click the first.
    expect(invalidate.length).toBeGreaterThanOrEqual(1);
    await act(async () => {
      invalidate[0]!.click();
    });

    // clear() wipes everything and reports the removed entries as a
    // deletion event — the same shape invalidate([cache]) produces, so
    // mounted useCache consumers refetch identically.
    expect(cache.snapshot!()).toEqual([]);
    expect(deleted).toEqual([[1], [2]]);
    expect(screen.queryByText('v1', {selector: 'td'})).toBeNull();
  });

  it('renders cache actions only when the provider implements them', () => {
    // snapshot-only provider: no delete/clear members, no action cells.
    render(
      <InjectDevTools
        injectables={[]}
        caches={[{snapshot: () => [{key: 'k', value: 'v', cachedAt: 0}]}]}
      />
    );
    expect(screen.getByText('v', {selector: 'td'})).toBeTruthy();
    expect(screen.queryByText('Actions', {selector: 'th'})).toBeNull();
    expect(screen.queryByRole('button', {name: /invalidate/i})).toBeNull();
    expect(screen.queryByRole('button', {name: /remove/i})).toBeNull();
  });

  it('Refetch replays the recorded args through the live injectable', async () => {
    const fetcher = vi.fn(async (n: number) => n * 10);
    let call: any;
    function Host() {
      const fn = useInjectable(fetcher);
      call = fn;
      // Same array passed as watch source and replay source: the common
      // `import.meta.env.DEV` usage — both props point at one useMemo'd
      // list — is what the Refetch button exists for.
      const watched = [fn] as const;
      return <InjectDevTools injectables={watched} refetchable={watched} />;
    }
    render(<Host />);

    await act(async () => {
      await call(3);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const refetch = screen.getByRole('button', {name: /refetch/i});
    await act(async () => {
      refetch.click();
    });

    // The recorded args [3] were re-run through the live injectable —
    // the full current wrapper chain, not a re-record of the old call.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(3);
  });

  it('Refetch swallows the replay rejection and still records it as an error row', async () => {
    const fetcher = vi.fn(async (n: number) => {
      if (n === 8) throw new Error('boom');
      return n;
    });
    let call: any;
    function Host() {
      const fn = useInjectable(fetcher);
      call = fn;
      const watched = [fn] as const;
      return <InjectDevTools injectables={watched} refetchable={watched} />;
    }
    render(<Host />);

    await act(async () => {
      await call(8).catch(() => {});
    });
    expect(screen.getByText('error', {selector: 'td'})).toBeTruthy();

    // The replay rejects (unhandled-rejection-safe) and lands as a NEW
    // error row — header + two error rows.
    const refetch = screen.getByRole('button', {name: /refetch/i});
    await act(async () => {
      refetch.click();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('error', {selector: 'td'})).toHaveLength(2);
  });

  it('Refetch strips an ABORTED trailing signal and replays the logical args', async () => {
    const fetcher = vi.fn(async (n: number, _signal?: AbortSignal) => `v${n}`);
    let call: any;
    function Host() {
      const fn = useInjectable(fetcher);
      call = fn;
      const watched = [fn] as const;
      return <InjectDevTools injectables={watched} refetchable={watched} />;
    }
    render(<Host />);

    // A signal-driven call in the useRun({signal: true}) shape; the
    // controller aborts before replay — the recorded run's owner is gone
    // (unmount/dep change aborts its signal), exactly the finding's repro.
    const controller = new AbortController();
    await act(async () => {
      await call(3, controller.signal);
    });
    controller.abort();

    const refetch = screen.getAllByRole('button', {name: /refetch/i})[0]!;
    await act(async () => {
      refetch.click();
    });

    // 0.14.0 replayed the dead signal verbatim — an abort-aware fetcher
    // would reject instantly after its owner unmounted. The replay now
    // carries the logical args only.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]).toEqual([3]);
  });

  it('Refetch replays a still-live trailing signal as-is', async () => {
    const fetcher = vi.fn(async (n: number, _signal?: AbortSignal) => `v${n}`);
    let call: any;
    function Host() {
      const fn = useInjectable(fetcher);
      call = fn;
      const watched = [fn] as const;
      return <InjectDevTools injectables={watched} refetchable={watched} />;
    }
    render(<Host />);

    const signal = new AbortController().signal;
    await act(async () => {
      await call(3, signal);
    });

    const refetch = screen.getAllByRole('button', {name: /refetch/i})[0]!;
    await act(async () => {
      refetch.click();
    });

    // A non-aborted signal still belongs to a live owner — the replay
    // keeps it, preserving abort linkage for runs that are still real.
    expect(fetcher.mock.calls[1]).toEqual([3, signal]);
  });

  it('hides the Actions column when no refetchable source is passed', () => {
    const fetcher = vi.fn(async (n: number) => n);
    let call: any;
    function Host() {
      const fn = useInjectable(fetcher);
      call = fn;
      return <InjectDevTools injectables={[fn]} />;
    }
    render(<Host />);
    expect(screen.queryByText('Actions', {selector: 'th'})).toBeNull();
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

describe('named injectable registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers on mount, unregisters on unmount, and notifies subscribers', () => {
    const changes: number[] = [];
    const stop = subscribeNamedInjectables(() => changes.push(changes.length));

    const fetcher = async (id: number) => id;
    let injectable: any;
    function Host() {
      injectable = useInjectable(fetcher, {name: 'fetchTags'});
      return null;
    }
    const {unmount} = render(<Host />);

    // Exactly the named instance is registered, and the registered name
    // doubles as the injectable's display name.
    expect(getNamedInjectables()).toEqual([injectable]);
    expect(injectable.name).toBe('fetchTags');
    expect(changes).toHaveLength(1);

    unmount();
    expect(getNamedInjectables()).toEqual([]);
    expect(changes).toHaveLength(2);
    stop();
  });

  it('leaves unnamed useInjectable completely untouched', () => {
    const changes: number[] = [];
    const stop = subscribeNamedInjectables(() => changes.push(changes.length));

    function Host() {
      useInjectable(async () => 'ok');
      return null;
    }
    const {unmount} = render(<Host />);

    // No registration, no notification — the unnamed path is exactly what
    // it was before the registry existed.
    expect(getNamedInjectables()).toEqual([]);
    expect(changes).toEqual([]);
    unmount();
    stop();
  });

  it('coexists under one name — unmount removes exactly its own instance', () => {
    const fetcher = async (x: number) => x;
    const seen: any[] = [];
    function Feature() {
      const fn = useInjectable(fetcher, {name: 'fetchTags'});
      if (!seen.includes(fn)) seen.push(fn);
      return null;
    }

    const first = render(<Feature />);
    const second = render(<Feature />);

    // Two hook instances, one name: both live — duplicate names coexist
    // rather than overwriting each other.
    expect(getNamedInjectables()).toEqual(seen);
    expect(seen).toHaveLength(2);

    first.unmount();
    expect(getNamedInjectables()).toEqual([seen[1]]);
    second.unmount();
    expect(getNamedInjectables()).toEqual([]);
  });

  it('observes a preset-internal injectable from a separate panel below it', async () => {
    // A useQuery-like preset: the injectable never leaves the hook, so a
    // panel cannot be handed a reference — the registry is the only way
    // in. useRun fires the first call from the feature's own mount
    // effects, in the same commit as the panel.
    function useQuery(fn: () => Promise<string[]>, options?: {name?: string}) {
      const fetcher = useInjectable(fn, options);
      useRun(fetcher, []);
      return useResult(fetcher);
    }
    function Tags() {
      const tags = useQuery(async () => ['t1', 't2'], {name: 'fetchTags'});
      return <span>{tags?.join(',')}</span>;
    }
    function App() {
      return (
        <>
          <Tags />
          <InjectDevTools />
        </>
      );
    }
    render(<App />);

    // The panel — a sibling AFTER the feature in tree order — recorded
    // the mount-time call under the registered name, not 'anonymous'.
    expect(await screen.findByText('fetchTags', {selector: 'td'})).toBeTruthy();
    expect(
      screen.getByText(/\[\] → \["t1","t2"\]/, {selector: 'td'})
    ).toBeTruthy();
  });

  it('observes a preset-internal injectable also when the panel sits above it', async () => {
    function useQuery(fn: () => Promise<string[]>, options?: {name?: string}) {
      const fetcher = useInjectable(fn, options);
      useRun(fetcher, []);
      return useResult(fetcher);
    }
    function Tags() {
      useQuery(async () => ['a'], {name: 'fetchTags'});
      return null;
    }
    function App() {
      return (
        <>
          <InjectDevTools />
          <Tags />
        </>
      );
    }
    render(<App />);

    // Insertion effects run tree-first: the panel subscribes to registry
    // changes before the feature registers, then attaches synchronously
    // inside the notification — the first call is observed in this order
    // too.
    expect(await screen.findByText('fetchTags', {selector: 'td'})).toBeTruthy();
  });

  it('keeps watching exactly the passed injectables — no registry by default', async () => {
    const namedFetcher = vi.fn(async () => 'named');
    const directFetcher = vi.fn(async () => 'direct');
    let named: any;
    let direct: any;
    function Feature() {
      named = useInjectable(namedFetcher, {name: 'fetchTags'});
      return null;
    }
    function Host() {
      direct = useInjectable(directFetcher);
      return (
        <>
          <Feature />
          <InjectDevTools injectables={[direct]} />
        </>
      );
    }
    render(<Host />);

    await act(async () => {
      await named();
      await direct();
    });

    // The explicit-prop mode is unchanged: only what was handed in is
    // watched, registry members are invisible. (The unnamed injectable
    // shows as 'anonymous'; its row is distinguished by the result.)
    expect(screen.getByText(/\[\] → direct/, {selector: 'td'})).toBeTruthy();
    expect(screen.queryByText('fetchTags', {selector: 'td'})).toBeNull();
    expect(screen.queryByText(/\[\] → named/, {selector: 'td'})).toBeNull();
  });

  it('merges explicit injectables and the registry with registry: true — overlap watched once', async () => {
    const fetcher = vi.fn(async (x: number) => x);
    let overlap: any;
    let namedOnly: any;
    let directFn: any;
    function Feature() {
      overlap = useInjectable(fetcher, {name: 'fetchTags'});
      namedOnly = useInjectable(fetcher, {name: 'fetchUsers'});
      return null;
    }
    // The overlap fn is captured from Feature's render, so it can only be
    // handed to the panel AFTER the first commit — hence the rerender.
    function Host({withOverlap}: {withOverlap: boolean}) {
      const fn = useInjectable(fetcher);
      directFn = fn;
      return (
        <>
          <Feature />
          {/* The overlap fn arrives through BOTH channels. */}
          <InjectDevTools
            injectables={withOverlap ? [fn, overlap] : [fn]}
            registry
          />
        </>
      );
    }
    const view = render(<Host withOverlap={false} />);
    view.rerender(<Host withOverlap={true} />);

    await act(async () => {
      await directFn(1);
      await overlap(2);
      await namedOnly(3);
    });

    // All three sources recorded — one row each, the overlap fn exactly
    // once despite arriving through both channels.
    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(screen.getByText(/\[1\]/, {selector: 'td'})).toBeTruthy();
    expect(screen.getByText(/\[2\]/, {selector: 'td'})).toBeTruthy();
    expect(screen.getByText(/\[3\]/, {selector: 'td'})).toBeTruthy();
  });

  it('keeps watching a prop injectable after its registry entry unregisters', async () => {
    const fetcher = vi.fn(async (x: number) => x);
    let overlap: any;
    let directFn: any;
    function Feature() {
      overlap = useInjectable(fetcher, {name: 'fetchTags'});
      return null;
    }
    // The overlap fn is only referenceable after Feature's first render,
    // so the panel grows the prop in phase 1 — then the feature unmounts
    // in phase 2 while the prop keeps holding the (now unregistered) fn.
    function Host({show, withOverlap}: {show: boolean; withOverlap: boolean}) {
      const fn = useInjectable(fetcher);
      directFn = fn;
      return (
        <>
          {show && <Feature />}
          <InjectDevTools
            injectables={withOverlap ? [fn, overlap] : [fn]}
            registry
          />
        </>
      );
    }
    const view = render(<Host show={true} withOverlap={false} />);
    view.rerender(<Host show={true} withOverlap={true} />);

    await act(async () => {
      await overlap(1);
    });
    expect(screen.getByText(/\[1\]/, {selector: 'td'})).toBeTruthy();

    // The registry entry is gone; the detach guard must spare the prop
    // member — its calls are still observed.
    view.rerender(<Host show={false} withOverlap={true} />);
    expect(getNamedInjectables()).toEqual([]);
    await act(async () => {
      await overlap(2);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/\[2\]/, {selector: 'td'})).toBeTruthy();
  });

  it('survives StrictMode double effects with exactly one registry entry and no duplicate rows', async () => {
    const fetcher = vi.fn(async (x: number) => x);
    let injectable: any;
    function Host() {
      injectable = useInjectable(fetcher, {name: 'fetchTags'});
      return <InjectDevTools />;
    }
    render(
      <StrictMode>
        <Host />
      </StrictMode>
    );

    // Insertion effects ran add → remove → add (simulated unmount/remount):
    // the registry holds exactly the one live instance.
    expect(getNamedInjectables()).toEqual([injectable]);

    await act(async () => {
      await injectable(7);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it('stops recording when the named feature unmounts — the chain keeps working', async () => {
    const fetcher = vi.fn(async (x: number) => x);
    let injectable: any;
    function Feature() {
      injectable = useInjectable(fetcher, {name: 'fetchTags'});
      return null;
    }
    function Host({show}: {show: boolean}) {
      return (
        <>
          {show && <Feature />}
          <InjectDevTools />
        </>
      );
    }
    const view = render(<Host show={true} />);

    await act(async () => {
      await injectable(1);
    });
    expect(screen.getAllByRole('row')).toHaveLength(2);

    // Unmounting the feature unregisters it; the panel detaches its
    // observer. The stale function reference still calls through the
    // (now observer-free) chain — the call resolves, nothing is recorded.
    view.rerender(<Host show={false} />);
    expect(getNamedInjectables()).toEqual([]);
    await act(async () => {
      await injectable(2);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/\[1\]/, {selector: 'td'})).toBeTruthy();
    expect(screen.queryByText(/\[2\]/, {selector: 'td'})).toBeNull();
  });
});
