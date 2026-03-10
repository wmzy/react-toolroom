import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useState, useEffect } from 'react';
import { useRun, useInjectable, createMemoryCacheProvider } from '../src/async';

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
      const fn = vi.fn(() => 'result');
      
      function TestComponent({ deps }: { deps: number[] }) {
        useRun(fn, deps);
        return <div>done</div>;
      }
      
      const { rerender } = render(<TestComponent deps={[1]} />);
      expect(fn).toHaveBeenCalledTimes(1);
      
      rerender(<TestComponent deps={[2]} />);
      expect(fn).toHaveBeenCalledTimes(2);
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
  });

  describe('createMemoryCacheProvider', () => {
    it('should create cache provider', () => {
      const provider = createMemoryCacheProvider<string, number[]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key),
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
        hash: (key) => JSON.stringify(key),
      });
      
      provider.set(['test'], 'cached value');
      const result = await provider.get(['test']);
      
      expect(result).toEqual(['cached value', expect.any(Number)]);
    });

    it('should return undefined for missing key', async () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key),
      });
      
      const result = await provider.get(['missing']);
      expect(result).toBeUndefined();
    });

    it('should delete cache entry', () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key),
      });
      
      provider.set(['test'], 'value');
      provider.delete(['test']);
      
      expect(provider.get(['test'])).toBeUndefined();
    });

    it('should clear all cache', () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key),
      });
      
      provider.set(['a'], 'value a');
      provider.set(['b'], 'value b');
      provider.clear();
      
      expect(provider.get(['a'])).toBeUndefined();
      expect(provider.get(['b'])).toBeUndefined();
    });

    it('should use hook correctly', () => {
      const provider = createMemoryCacheProvider<string, [string]>({
        cacheTime: 60000,
        hash: (key) => JSON.stringify(key),
      });
      
      const cleanup = provider.use();
      expect(cleanup).toBeDefined();
      expect(typeof cleanup).toBe('function');
      
      cleanup();
    });
  });
});
