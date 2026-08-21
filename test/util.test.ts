import {describe, it, expect} from 'vitest';
import {
  thru,
  thruSet,
  thruError,
  noop,
  getDisplayName,
  stableHash
} from '../src/util';

describe('util', () => {
  describe('thru', () => {
    it('should return the original value after calling interceptor', () => {
      const interceptor = (v: number) => v * 2;
      const result = thru(interceptor)(5);
      expect(result).toBe(5);
    });

    it('should call interceptor with the value', () => {
      let calledWith: number | undefined;
      const interceptor = (v: number) => {
        calledWith = v;
      };
      thru(interceptor)(42);
      expect(calledWith).toBe(42);
    });

    it('should work with objects', () => {
      const obj = {a: 1};
      const interceptor = (v: typeof obj) => {
        v.a = 2;
      };
      const result = thru(interceptor)(obj);
      expect(result).toBe(obj);
      expect(result.a).toBe(2);
    });

    it('should work with strings', () => {
      const interceptor = (v: string) => v.toUpperCase();
      const result = thru(interceptor)('hello');
      expect(result).toBe('hello');
    });
  });

  describe('thruSet', () => {
    it('should call set function with a function that returns the value', () => {
      let storedValue: number | undefined;
      const set = (fn: () => number) => {
        storedValue = fn();
      };
      const result = thruSet(set)(42);
      expect(result).toBe(42);
      expect(storedValue).toBe(42);
    });

    it('should work with objects', () => {
      const obj = {name: 'test'};
      let storedValue: typeof obj | undefined;
      const set = (fn: () => typeof obj) => {
        storedValue = fn();
      };
      const result = thruSet(set)(obj);
      expect(result).toBe(obj);
      expect(storedValue).toBe(obj);
    });

    it('should work with arrays', () => {
      const arr = [1, 2, 3];
      let storedValue: number[] | undefined;
      const set = (fn: () => number[]) => {
        storedValue = fn();
      };
      const result = thruSet(set)(arr);
      expect(result).toBe(arr);
      expect(storedValue).toBe(arr);
    });
  });

  describe('thruError', () => {
    it('should throw the error after calling set', () => {
      const error = new Error('test error');
      let setError: Error | undefined;
      const set = (e: Error) => {
        setError = e;
      };
      expect(() => thruError(set)(error)).toThrow('test error');
      expect(setError).toBe(error);
    });

    it('should preserve error type', () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }
      const error = new CustomError('custom error');
      let setError: CustomError | undefined;
      const set = (e: CustomError) => {
        setError = e;
      };
      expect(() => thruError(set)(error)).toThrow(CustomError);
      expect(setError).toBe(error);
    });

    it('should rethrow the same error instance', () => {
      const error = new Error('same error');
      let capturedError: Error | undefined;
      const set = (e: Error) => {
        capturedError = e;
      };
      try {
        thruError(set)(error);
      } catch (e) {
        expect(e).toBe(error);
      }
      expect(capturedError).toBe(error);
    });
  });

  describe('noop', () => {
    it('should be a function', () => {
      expect(typeof noop).toBe('function');
    });

    it('should return undefined', () => {
      expect(noop()).toBeUndefined();
    });

    it('should be callable without arguments', () => {
      expect(noop()).toBeUndefined();
    });
  });

  describe('getDisplayName', () => {
    it('should return displayName if present', () => {
      const Component = function Test() {
        return null;
      };
      Component.displayName = 'MyComponent';
      expect(getDisplayName(Component)).toBe('MyComponent');
    });

    it('should return name if displayName is not present', () => {
      function MyComponent() {
        return null;
      }
      expect(getDisplayName(MyComponent)).toBe('MyComponent');
    });

    it('should return Component if neither displayName nor name', () => {
      const Component = () => null;
      Object.defineProperty(Component, 'name', {value: ''});
      expect(getDisplayName(Component)).toBe('Component');
    });

    it('should work with arrow functions that have names', () => {
      const MyArrow = () => null;
      expect(getDisplayName(MyArrow)).toBe('MyArrow');
    });

    it('should work with named function expressions', () => {
      const Component = function NamedFunction() {
        return null;
      };
      expect(getDisplayName(Component)).toBe('NamedFunction');
    });

    it('should prefer displayName over name', () => {
      const Component = function Test() {
        return null;
      };
      Component.displayName = 'PreferredName';
      expect(getDisplayName(Component)).toBe('PreferredName');
    });
  });

  describe('stableHash', () => {
    it('should hash primitives by type', () => {
      expect(stableHash(undefined)).toBe('u');
      expect(stableHash(null)).toBe('n');
      expect(stableHash(true)).not.toBe(stableHash(false));
    });

    it('should distinguish 1 and "1"', () => {
      expect(stableHash(1)).not.toBe(stableHash('1'));
      expect(stableHash(1)).not.toBe(stableHash([1]));
    });

    it('should treat equivalent objects with different key order as equal', () => {
      expect(stableHash({a: 1, b: 2})).toBe(stableHash({b: 2, a: 1}));
      expect(stableHash({a: 1, b: 2})).not.toBe(stableHash({a: 2, b: 1}));
      expect(stableHash({a: 1})).not.toBe(stableHash({a: 1, b: 2}));
    });

    it('should hash Dates with the same instant equally', () => {
      expect(stableHash(new Date(1000))).toBe(stableHash(new Date(1000)));
      expect(stableHash(new Date(1000))).not.toBe(stableHash(new Date(2000)));
    });

    it('should return a fixed placeholder for AbortSignal', () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      expect(stableHash(controller1.signal)).toBe('#sig');
      expect(stableHash(controller2.signal)).toBe('#sig');
      expect(stableHash([controller1.signal])).toBe(
        stableHash([controller2.signal])
      );
    });

    it('should return stable hashes for function references', () => {
      const fn = () => {};
      const other = () => {};
      expect(stableHash(fn)).toBe(stableHash(fn));
      expect(stableHash(fn)).not.toBe(stableHash(other));
      expect(stableHash({callback: fn})).toBe(stableHash({callback: fn}));
    });

    it('should not throw on circular references', () => {
      const obj: any = {name: 'cycle'};
      obj.self = obj;
      expect(() => stableHash(obj)).not.toThrow();
      expect(stableHash(obj)).toBe(stableHash(obj));

      const arr: any[] = [];
      arr.push(arr);
      expect(() => stableHash(arr)).not.toThrow();
    });

    it('should hash nested arrays and objects structurally', () => {
      const a = {list: [1, {x: 'y'}], meta: {ok: true}};
      const b = {meta: {ok: true}, list: [1, {x: 'y'}]};
      expect(stableHash(a)).toBe(stableHash(b));
      expect(stableHash(a)).not.toBe(
        stableHash({list: [1, {x: 'z'}], meta: {ok: true}})
      );
      expect(stableHash([[1, 2], [3]])).toBe(stableHash([[1, 2], [3]]));
      expect(stableHash([[1, 2], [3]])).not.toBe(stableHash([[3], [1, 2]]));
    });

    it('should hash Map entries and Set values order-independently', () => {
      expect(
        stableHash(
          new Map([
            ['a', 1],
            ['b', 2]
          ])
        )
      ).toBe(
        stableHash(
          new Map([
            ['b', 2],
            ['a', 1]
          ])
        )
      );
      expect(stableHash(new Map([['a', 1]]))).not.toBe(
        stableHash(new Map([['a', 2]]))
      );
      expect(stableHash(new Set([1, 2, 3]))).toBe(
        stableHash(new Set([3, 2, 1]))
      );
      expect(stableHash(new Set([1, 2]))).not.toBe(stableHash(new Set([1, 3])));
    });
  });
});
