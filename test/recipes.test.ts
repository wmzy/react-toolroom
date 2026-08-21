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

import {describe, it, expect, vi, beforeEach} from 'vitest';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createElement, useState} from 'react';
import {useProjectQuery} from '../recipes/useProjectQuery';
import {useProjectSWRQuery} from '../recipes/useProjectSWRQuery';
import {useProjectPollingQuery} from '../recipes/useProjectPollingQuery';
import {useProjectPaginatedQuery} from '../recipes/useProjectPaginatedQuery';

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
