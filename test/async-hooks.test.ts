import {describe, it, expect, vi} from 'vitest';
import {
  useRun,
  useInjectable,
  createMemoryCacheProvider,
  useResult,
  useLoading,
  useError,
  useFailureCount,
  useCatch,
  useFinally,
  useRetry,
  useCache,
  getInjectContext,
  useInject
} from '../src/async';
import {useLoadingFn, useResult as useResultBase} from '../src/async/base';
import {useInjectBefore} from '../src/async/inject';

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

  it('should export useLoading', () => {
    expect(useLoading).toBeDefined();
    expect(typeof useLoading).toBe('function');
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

  it('should export getInjectContext', () => {
    expect(getInjectContext).toBeDefined();
    expect(typeof getInjectContext).toBe('function');
  });

  it('should export useInject', () => {
    expect(useInject).toBeDefined();
    expect(typeof useInject).toBe('function');
  });
});

describe('async/base exports', () => {
  it('should export useLoadingFn', () => {
    expect(useLoadingFn).toBeDefined();
    expect(typeof useLoadingFn).toBe('function');
  });

  it('should export useResultBase', () => {
    expect(useResultBase).toBeDefined();
    expect(typeof useResultBase).toBe('function');
  });
});

describe('async/inject exports', () => {
  it('should export useInjectBefore', () => {
    expect(useInjectBefore).toBeDefined();
    expect(typeof useInjectBefore).toBe('function');
  });
});
