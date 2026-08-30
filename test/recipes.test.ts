/**
 * Drift-prevention tests for the recipes/ templates.
 *
 * New file rather than an append to test/async-hooks.test.ts or
 * test/async.test.tsx because the templates live outside src/ and belong
 * to none of the existing test domains — append further recipe tests here.
 *
 * The demo service modules are mocked (vi.mock) so the templates keep
 * their real import wiring while each test controls fetch behavior and
 * timing through the mocks.
 */

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createElement, useState} from 'react';
import {useProjectQuery} from '../recipes/useProjectQuery';
import {useProjectSWRQuery} from '../recipes/useProjectSWRQuery';
import {useProjectPollingQuery} from '../recipes/useProjectPollingQuery';
import {useProjectPaginatedQuery} from '../recipes/useProjectPaginatedQuery';
import {useProjectMutation, renameProject} from '../recipes/useProjectMutation';
import {createLocalCacheProvider} from '../recipes/createLocalCacheProvider';

const {fetchListMock, fetchTickerMock, fetchByIdMock} = vi.hoisted(() => ({
  fetchListMock: vi.fn(),
  fetchTickerMock: vi.fn(),
  fetchByIdMock: vi.fn()
}));

vi.mock('@/services/user', () => ({
  fetchList: fetchListMock,
  fetchById: fetchByIdMock
}));

vi.mock('@/services/metrics', () => ({
  fetchTicker: fetchTickerMock
}));

// A controllable promise — resolves only when the test says so.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return {promise, resolve};
}

const projects = ['alpha', 'beta', 'gamma'].map((username, i) => ({
  id: i + 1,
  username,
  description: '',
  updatedAt: 0
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recipes/useProjectQuery', () => {
  function ProjectListView() {
    const {data, initialLoading, error} = useProjectQuery();
    if (initialLoading) return createElement('p', null, 'skeleton');
    if (error) return createElement('p', null, error.message);
    return createElement(
      'ul',
      null,
      ...(data ?? []).map((p) => createElement('li', {key: p.id}, p.username))
    );
  }

  it('should render the skeleton first, then the data', async () => {
    const first = deferred<typeof projects>();
    fetchListMock.mockImplementationOnce(() => first.promise);
    render(createElement(ProjectListView));
    // request in flight and no result yet -> initial skeleton
    expect(screen.getByText('skeleton')).toBeTruthy();
    await act(async () => {
      first.resolve(projects);
    });
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.queryByText('skeleton')).toBeNull();
    expect(fetchListMock).toHaveBeenCalledTimes(1);
  });

  it('should forward an explicit size (plus the trailing AbortSignal) to fetchList', async () => {
    fetchListMock.mockImplementation(async () => projects);

    function SizedView() {
      const {data} = useProjectQuery({size: 2});
      return createElement(
        'ul',
        null,
        ...(data ?? []).map((p) => createElement('li', {key: p.id}, p.username))
      );
    }

    render(createElement(SizedView));
    expect(await screen.findByText('alpha')).toBeTruthy();
    expect(fetchListMock).toHaveBeenCalledTimes(1);
    // signal: true appends an AbortSignal after the size argument
    expect(fetchListMock).toHaveBeenCalledWith(2, expect.any(AbortSignal));
  });
});

describe('recipes/useProjectSWRQuery', () => {
  // staleTime 0: every cache hit revalidates in the background — the
  // aggressive setting that makes remount and focus refetches observable.
  function ProjectListView({staleTime}: {staleTime: number}) {
    const {data, initialLoading} = useProjectSWRQuery({staleTime});
    if (initialLoading) return createElement('p', null, 'skeleton');
    return createElement(
      'ul',
      null,
      ...(data ?? []).map((p) => createElement('li', {key: p.id}, p.username))
    );
  }

  it('should serve the cache across remounts and revalidate on focus', async () => {
    fetchListMock.mockImplementation(async () => projects);

    const {unmount} = render(createElement(ProjectListView, {staleTime: 0}));
    expect(await screen.findByText('alpha')).toBeTruthy();
    expect(fetchListMock).toHaveBeenCalledTimes(1); // first load: cache miss

    unmount();
    render(createElement(ProjectListView, {staleTime: 0}));
    // cached entry renders again immediately, then a background
    // revalidation fires (staleTime 0)
    expect(await screen.findByText('alpha')).toBeTruthy();
    await waitFor(() => expect(fetchListMock).toHaveBeenCalledTimes(2));

    // focus revalidation goes through the same [] cache line
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(fetchListMock).toHaveBeenCalledTimes(3));
  });

  it('should serve a fresh entry across remounts at the default staleTime', async () => {
    fetchListMock.mockImplementation(async () => projects);

    // No options at all: the default 5000ms freshness window applies.
    function DefaultStaleView() {
      const {data, initialLoading} = useProjectSWRQuery();
      if (initialLoading) return createElement('p', null, 'skeleton');
      return createElement(
        'ul',
        null,
        ...(data ?? []).map((p) => createElement('li', {key: p.id}, p.username))
      );
    }

    const {unmount} = render(createElement(DefaultStaleView));
    expect(await screen.findByText('alpha')).toBeTruthy();
    const callsAfterFirstMount = fetchListMock.mock.calls.length;

    unmount();
    render(createElement(DefaultStaleView));
    expect(await screen.findByText('alpha')).toBeTruthy();
    // the entry is still inside its freshness window: no revalidation
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchListMock.mock.calls.length).toBe(callsAfterFirstMount);
  });

  it('should refetch through refetch() and surface failures as error state, not rejections', async () => {
    fetchListMock.mockImplementation(async () => projects);
    let refetchFn: (() => Promise<typeof projects | undefined>) | undefined;

    function RefreshView() {
      const {data, error, refetch} = useProjectSWRQuery();
      refetchFn = refetch;
      if (error) return createElement('p', null, `error: ${error.message}`);
      return createElement(
        'ul',
        null,
        ...(data ?? []).map((p) => createElement('li', {key: p.id}, p.username))
      );
    }

    render(createElement(RefreshView));
    expect(await screen.findByText('alpha')).toBeTruthy();
    // the module-scope projectCache may carry entries from earlier tests —
    // count relatively
    const callsAfterMount = fetchListMock.mock.calls.length;

    // refetch drops the fresh entry and forces one new request
    await act(async () => {
      await refetchFn!();
    });
    expect(fetchListMock.mock.calls.length).toBe(callsAfterMount + 1);

    // a failing refetch resolves undefined (no rejection to handle) and
    // the failure lands in the error field instead
    fetchListMock.mockImplementation(async () => {
      throw new Error('refresh failed');
    });
    let settled: unknown = 'pending';
    await act(async () => {
      void refetchFn!().then(
        (v) => {
          settled = v;
        },
        () => {
          settled = 'rejected';
        }
      );
    });
    expect(settled).toBeUndefined();
    expect(await screen.findByText('error: refresh failed')).toBeTruthy();
  });
});

describe('recipes/useProjectPollingQuery', () => {
  function TickerView() {
    const {data, initialLoading, error} = useProjectPollingQuery();
    if (initialLoading) return createElement('p', null, 'skeleton');
    if (error) return createElement('p', null, error.message);
    return createElement('p', null, `tick ${data?.tick}`);
  }

  it('should fetch once and refresh on each 3 s tick', async () => {
    vi.useFakeTimers();
    let tick = 0;
    fetchTickerMock.mockImplementation(async () => ({
      tick: ++tick,
      at: 'now'
    }));
    try {
      render(createElement(TickerView));
      await act(async () => {});
      expect(screen.getByText('tick 1')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByText('tick 2')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByText('tick 3')).toBeTruthy();
      expect(fetchTickerMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('recipes/useProjectPaginatedQuery', () => {
  function PagedView({placeholder}: {placeholder?: typeof projects}) {
    const [page, setPage] = useState(1);
    const {data, isPlaceholderData, initialLoading, loading} =
      useProjectPaginatedQuery(
        page,
        10,
        placeholder ? {placeholderData: placeholder} : {}
      );
    const texts = [
      ...(initialLoading ? ['skeleton'] : []),
      ...(loading ? ['refreshing'] : []),
      ...(isPlaceholderData ? ['placeholder'] : []),
      ...(data ?? []).map((p) => p.username)
    ];
    return createElement(
      'div',
      null,
      ...texts.map((t) => createElement('p', {key: t}, t)),
      createElement(
        'button',
        {type: 'button', onClick: () => setPage(page + 1)},
        'next'
      )
    );
  }

  it('should skeleton the first page, keep it while page 2 loads', async () => {
    const all = Array.from({length: 20}, (_, i) => ({
      id: i + 1,
      username: `user ${i + 1}`,
      description: '',
      updatedAt: 0
    }));
    const first = deferred<typeof all>();
    const second = deferred<typeof all>();
    fetchListMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    render(createElement(PagedView));
    // first load: full-page skeleton, no rows yet
    expect(screen.getByText('skeleton')).toBeTruthy();
    expect(screen.queryByText('user 1')).toBeNull();

    await act(async () => {
      first.resolve(all);
    });
    expect(screen.getByText('user 1')).toBeTruthy();
    expect(screen.getByText('user 10')).toBeTruthy();
    expect(screen.queryByText('skeleton')).toBeNull();
    expect(screen.queryByText('refreshing')).toBeNull();
    expect(screen.queryByText('placeholder')).toBeNull();

    fireEvent.click(screen.getByText('next'));
    // page change: keep-previous-data keeps page 1 on screen behind a small
    // refreshing indicator — NOT the full-page skeleton — and flags the
    // kept rows as placeholder data
    expect(screen.getByText('refreshing')).toBeTruthy();
    expect(screen.getByText('placeholder')).toBeTruthy();
    expect(screen.getByText('user 1')).toBeTruthy();
    expect(screen.queryByText('skeleton')).toBeNull();

    await act(async () => {
      second.resolve(all);
    });
    expect(screen.getByText('user 11')).toBeTruthy();
    expect(screen.queryByText('user 1')).toBeNull();
    expect(screen.queryByText('refreshing')).toBeNull();
    expect(screen.queryByText('placeholder')).toBeNull();
  });

  it('should display placeholderData before the first page lands', async () => {
    const all = Array.from({length: 20}, (_, i) => ({
      id: i + 1,
      username: `user ${i + 1}`,
      description: '',
      updatedAt: 0
    }));
    const first = deferred<typeof all>();
    fetchListMock.mockImplementationOnce(() => first.promise);

    render(
      createElement(PagedView, {
        placeholder: [{id: 0, username: 'seed', description: '', updatedAt: 0}]
      })
    );
    // no skeleton: the placeholder rows are on screen, flagged as such
    expect(screen.queryByText('skeleton')).toBeNull();
    expect(screen.getByText('placeholder')).toBeTruthy();
    expect(screen.getByText('seed')).toBeTruthy();

    await act(async () => {
      first.resolve(all);
    });
    // first real page lands: the placeholder window is over
    expect(screen.queryByText('placeholder')).toBeNull();
    expect(screen.getByText('user 1')).toBeTruthy();
  });

  it('should default to page size 10 when called without one', async () => {
    const all = Array.from({length: 35}, (_, i) => ({
      id: i + 1,
      username: `user ${i + 1}`,
      description: '',
      updatedAt: 0
    }));
    const first = deferred<typeof all>();
    fetchListMock.mockImplementationOnce(() => first.promise);

    function TwoArgView() {
      // the (page, options) overload: no pageSize anywhere
      const {data} = useProjectPaginatedQuery(1);
      return createElement(
        'ul',
        null,
        ...(data ?? []).map((p) => createElement('li', {key: p.id}, p.username))
      );
    }

    render(createElement(TwoArgView));
    await act(async () => {
      first.resolve(all);
    });
    expect(screen.getByText('user 1')).toBeTruthy();
    // page 1 of the DEFAULT size: rows 1-10 only, no row 11
    expect(screen.getByText('user 10')).toBeTruthy();
    expect(screen.queryByText('user 11')).toBeNull();
    expect(fetchListMock).toHaveBeenCalledTimes(1);
    // fetchProjectPage fetched the full list (no args) and sliced to the
    // default page size 10 client-side
    expect(fetchListMock).toHaveBeenCalledWith();
  });
});

// The mutation template (recipes/useProjectMutation.ts). Since the
// library ships a first-class useMutation (covered in
// test/async-hooks.test.ts), these tests pin the template's added value
// only: default-vs-explicit onError wiring.
describe('recipes/useProjectMutation', () => {
  function MutationView({
    save,
    onError
  }: {
    save: (name: string) => Promise<string>;
    onError?: (error: Error, ...args: any[]) => void;
  }) {
    const [mutate, {isMutating, error}] = useProjectMutation(save, {
      onError
    });
    return createElement(
      'div',
      null,
      createElement('p', null, isMutating ? 'mutating' : 'idle'),
      ...(error ? [createElement('p', null, error.message)] : []),
      // Fire-and-forget call: rejections propagate out of `mutate`, so
      // callers that read `error` instead of awaiting append a catch.
      createElement(
        'button',
        {type: 'button', onClick: () => mutate('alpha').catch(() => {})},
        'rename'
      )
    );
  }

  it('should report failures to the default reporter when no onError is given', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        createElement(MutationView, {
          save: () => Promise.reject(new Error('boom'))
        })
      );
      fireEvent.click(screen.getByText('rename'));
      await act(async () => {});
      expect(screen.getByText('boom')).toBeTruthy();
      expect(screen.getByText('idle')).toBeTruthy(); // not stuck mutating
      expect(reported).toHaveBeenCalledTimes(1);
      const reportedError = reported.mock.calls[0]![1];
      expect(reportedError).toBeInstanceOf(Error);
      expect((reportedError as Error).message).toBe('boom');
    } finally {
      reported.mockRestore();
    }
  });

  it('should let an explicit onError replace the default reporter', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    try {
      render(
        createElement(MutationView, {
          save: () => Promise.reject(new Error('boom')),
          onError
        })
      );
      fireEvent.click(screen.getByText('rename'));
      await act(async () => {});
      expect(onError).toHaveBeenCalledWith(expect.any(Error), 'alpha');
      expect(screen.getByText('boom')).toBeTruthy();
      expect(reported).not.toHaveBeenCalled();
    } finally {
      reported.mockRestore();
    }
  });

  it('should rename through fetchById and resolve the merged user without options', async () => {
    const user = projects[0]!;
    fetchByIdMock.mockImplementation(async () => user);
    let captured!: Promise<typeof user>;

    function Renamer() {
      // no options object: the default reporter wiring path
      const [rename] = useProjectMutation(renameProject);
      return createElement(
        'button',
        {
          type: 'button',
          onClick: () => {
            captured = rename(user.id, 'renamed');
          }
        },
        'rename'
      );
    }

    render(createElement(Renamer));
    fireEvent.click(screen.getByText('rename'));
    const result = await act(async () => captured);

    expect(fetchByIdMock).toHaveBeenCalledWith(user.id);
    expect(result).toEqual({...user, username: 'renamed'});
  });
});

// The localStorage cache provider factory
// (recipes/createLocalCacheProvider.ts). test/setup.ts replaces the jsdom
// localStorage with no-op vi.fn()s, so this suite swaps in a real
// in-memory Storage on the global for the persistence path; write failures
// are simulated by making that instance's setItem throw (quota/privacy).
describe('recipes/createLocalCacheProvider', () => {
  // A minimal spec-compliant Storage, so the persistence path runs against
  // a store that actually reads back what was written.
  function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k) => (map.has(k) ? map.get(k)! : null),
      key: (i) => [...map.keys()][i] ?? null,
      removeItem: (k) => void map.delete(k),
      setItem: (k, v) => void map.set(k, String(v))
    } as Storage;
  }

  const setupStorage = globalThis.localStorage;
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
    globalThis.localStorage = storage;
  });

  afterEach(() => {
    globalThis.localStorage = setupStorage;
    vi.restoreAllMocks();
  });

  it('should refill a fresh provider from localStorage with timestamps intact', () => {
    const a = createLocalCacheProvider<string, any[]>({key: 'rt:test:refill'});
    a.set(['x'], 'hello');
    const stored = a.get(['x']);
    expect(storage.getItem('rt:test:refill')).toBeTruthy();

    const b = createLocalCacheProvider<string, any[]>({key: 'rt:test:refill'});
    expect(b.get(['x'])).toEqual(stored); // value AND cachedAt survived

    // deletions persist too — the next provider starts without the entry
    a.delete(['x']);
    const c = createLocalCacheProvider<string, any[]>({key: 'rt:test:refill'});
    expect(c.get(['x'])).toBeUndefined();
  });

  it('should degrade to the plain memory provider when storage never works', () => {
    const spy = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    const a = createLocalCacheProvider<string, any[]>({key: 'rt:test:quota'});
    expect(() => a.set(['x'], 'hello')).not.toThrow();
    expect(a.get(['x'])).toEqual(['hello', expect.any(Number)]);

    spy.mockRestore();
    const b = createLocalCacheProvider<string, any[]>({key: 'rt:test:quota'});
    expect(b.get(['x'])).toBeUndefined(); // nothing ever hit the disk
  });

  it('should keep serving from memory when writes fail after creation', () => {
    const a = createLocalCacheProvider<string, any[]>({key: 'rt:test:late'});
    a.set(['x'], 'hello'); // healthy write

    const spy = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(() => a.set(['y'], 'world')).not.toThrow(); // silent degradation
    expect(a.get(['y'])).toEqual(['world', expect.any(Number)]); // memory wins

    spy.mockRestore();
    const b = createLocalCacheProvider<string, any[]>({key: 'rt:test:late'});
    expect(b.get(['x'])).toEqual(['hello', expect.any(Number)]); // last good write
    expect(b.get(['y'])).toBeUndefined(); // the failed write did not persist
  });

  it('should return the plain memory provider when window is undefined (SSR)', () => {
    vi.stubGlobal('window', undefined);
    try {
      const p = createLocalCacheProvider<string, any[]>({key: 'rt:test:ssr'});
      p.set(['x'], 'hello');
      expect(p.get(['x'])).toEqual(['hello', expect.any(Number)]);
      // storage was never touched — no probe, no mirror write
      expect(storage.getItem('rt:test:ssr')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
