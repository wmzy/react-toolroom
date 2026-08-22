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
import {useProjectMutation} from '../recipes/useProjectMutation';
import {createLocalCacheProvider} from '../recipes/createLocalCacheProvider';

const {fetchListMock, fetchTickerMock} = vi.hoisted(() => ({
  fetchListMock: vi.fn(),
  fetchTickerMock: vi.fn()
}));

vi.mock('@/services/user', () => ({
  fetchList: fetchListMock,
  fetchById: vi.fn()
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
  function PagedView() {
    const [page, setPage] = useState(1);
    const {data, initialLoading, loading} = useProjectPaginatedQuery(page);
    const texts = [
      ...(initialLoading ? ['skeleton'] : []),
      ...(loading ? ['refreshing'] : []),
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

    fireEvent.click(screen.getByText('next'));
    // page change: keep-previous-data keeps page 1 on screen behind a small
    // refreshing indicator — NOT the full-page skeleton
    expect(screen.getByText('refreshing')).toBeTruthy();
    expect(screen.getByText('user 1')).toBeTruthy();
    expect(screen.queryByText('skeleton')).toBeNull();

    await act(async () => {
      second.resolve(all);
    });
    expect(screen.getByText('user 11')).toBeTruthy();
    expect(screen.queryByText('user 1')).toBeNull();
    expect(screen.queryByText('refreshing')).toBeNull();
  });
});

// The mutation template (recipes/useProjectMutation.ts): the hook is
// generic over the wrapped mutation, so these tests drive it with inline
// functions instead of a mocked service module.
describe('recipes/useProjectMutation', () => {
  function MutationView({
    save,
    onSuccess,
    onError
  }: {
    save: (name: string) => Promise<string>;
    onSuccess?: (...args: any[]) => void;
    onError?: (...args: any[]) => void;
  }) {
    const [mutate, {isMutating, error, failureCount}] = useProjectMutation(
      save,
      {onSuccess, onError}
    );
    return createElement(
      'div',
      null,
      createElement('p', null, isMutating ? 'mutating' : 'idle'),
      ...(error ? [createElement('p', null, error.message)] : []),
      createElement('p', null, `failures ${failureCount}`),
      // Fire-and-forget call: rejections propagate out of `mutate`, so
      // callers that read `error` instead of awaiting append a catch.
      createElement(
        'button',
        {type: 'button', onClick: () => mutate('alpha').catch(() => {})},
        'rename'
      )
    );
  }

  it('should flip isMutating around the call and fire onSuccess with result and args', async () => {
    const onSuccess = vi.fn();
    const first = deferred<string>();

    render(
      createElement(MutationView, {
        save: () => first.promise,
        onSuccess
      })
    );
    expect(screen.getByText('idle')).toBeTruthy();

    fireEvent.click(screen.getByText('rename'));
    expect(screen.getByText('mutating')).toBeTruthy();

    await act(async () => {
      first.resolve('saved');
    });
    expect(screen.getByText('idle')).toBeTruthy();
    expect(screen.queryByText('mutating')).toBeNull();
    expect(onSuccess).toHaveBeenCalledWith('saved', 'alpha');
    expect(screen.getByText('failures 0')).toBeTruthy();
  });

  it('should surface the error, count failures, then reset both on success', async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    let fail = true;
    const save = (name: string) =>
      fail ? Promise.reject(new Error('boom')) : Promise.resolve('saved');

    render(createElement(MutationView, {save, onSuccess, onError}));

    fireEvent.click(screen.getByText('rename'));
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    expect(screen.getByText('failures 1')).toBeTruthy();
    expect(screen.getByText('idle')).toBeTruthy(); // not stuck mutating
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'alpha');
    expect(onSuccess).not.toHaveBeenCalled();

    fail = false;
    fireEvent.click(screen.getByText('rename'));
    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith('saved', 'alpha')
    );
    // a success clears the shared error and resets the failure tally
    await waitFor(() => {
      expect(screen.queryByText('boom')).toBeNull();
      expect(screen.getByText('failures 0')).toBeTruthy();
    });
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
});
