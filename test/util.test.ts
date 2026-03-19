import {describe, it, expect} from 'vitest';
import {thru, thruSet, thruError, noop, getDisplayName} from '../src/util';

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
});
