/**
 * Isolated coverage for the useSESFallback shim in src/async/base.ts.
 *
 * 来源：覆盖率提升任务。base.ts 在模块加载时以
 * `useSyncExternalStore ?? useSESFallback` 选择订阅实现，测试该分支必须
 * 让 React 的 useSyncExternalStore 解析为 undefined（模拟 React 16.8–17
 * peer），而这只能通过文件级 vi.mock('react') 实现——放入共享测试文件会
 * 波及所有用例，故按规则第 4 类单独成文件。
 *
 * 归并建议：不可归并（模块级 mock 的固有隔离需求）。
 */

import {describe, it, expect, vi} from 'vitest';
import {act, render, screen, waitFor} from '@testing-library/react';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    // React 16.8–17 peers do not export useSyncExternalStore.
    useSyncExternalStore: undefined
  };
});

import {useInjectable, useResult, useRun} from '../src/async';

describe('useSESFallback (React 16.8–17 peers)', () => {
  it('should serve store values and propagate updates through the shim', async () => {
    let resolveFn!: (v: string) => void;
    const fetchData = () =>
      new Promise<string>((resolve) => {
        resolveFn = resolve;
      });

    function TestComponent() {
      const injectable = useInjectable(fetchData);
      const result = useResult(injectable);
      useRun(injectable, []);
      return <span data-testid='result'>{result ?? 'pending'}</span>;
    }

    render(<TestComponent />);
    // first frame reads the (result-less) snapshot through the shim
    expect(screen.getByTestId('result').textContent).toBe('pending');

    await act(async () => {
      resolveFn('delivered');
    });
    // the shim's subscription caught the broadcast and re-rendered
    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('delivered');
    });
  });
});
