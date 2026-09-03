import {describe, it, expect} from 'vitest';
import {
  thru,
  thruSet,
  thruError,
  noop,
  getDisplayName,
  stableHash,
  isAbortSignal,
  stripVolatile
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

    it('should hash symbols by registry key or description', () => {
      // Registered symbols carry a global identity: same key, same hash;
      // different keys, different hashes.
      expect(stableHash(Symbol.for('shared'))).toBe(
        stableHash(Symbol.for('shared'))
      );
      expect(stableHash(Symbol.for('a'))).not.toBe(stableHash(Symbol.for('b')));
      // Unregistered symbols hash by description.
      expect(stableHash(Symbol('a'))).not.toBe(stableHash(Symbol('b')));
      expect(stableHash({tag: Symbol('a')})).not.toBe(
        stableHash({tag: Symbol('b')})
      );
      // A registered and an unregistered symbol never collide, even with
      // the same name — the two placeholder forms differ (`sym#` vs `sym:`).
      expect(stableHash(Symbol.for('a'))).not.toBe(stableHash(Symbol('a')));
    });

    it('should keep same-description collisions and fold anonymous symbols', () => {
      // Documented behavior: two distinct symbols sharing a description
      // are structurally indistinguishable, so they collide.
      expect(stableHash(Symbol('a'))).toBe(stableHash(Symbol('a')));
      // Anonymous symbols (no description) all fold to one placeholder.
      expect(stableHash(Symbol())).toBe(stableHash(Symbol()));
    });

    it('should drop object keys holding undefined', () => {
      // A schema output that omits defaulted fields and a state object
      // that carries them as undefined properties name the same entity.
      expect(stableHash({a: undefined})).toBe(stableHash({}));
      expect(stableHash({a: 1, b: undefined})).toBe(stableHash({a: 1}));
      expect(stableHash({a: undefined})).not.toBe(stableHash({a: null}));
      // Array slots keep their position — a hole is information.
      expect(stableHash([undefined])).not.toBe(stableHash([]));
    });

    it('should mark invalid dates distinctly from valid ones', () => {
      const invalid = new Date(Number.NaN);
      expect(stableHash(invalid)).toBe(stableHash(new Date('not a date')));
      expect(stableHash(invalid)).not.toBe(stableHash(new Date(1000)));
    });
  });

  describe('isAbortSignal', () => {
    it('should return true for a real AbortSignal', () => {
      expect(isAbortSignal(new AbortController().signal)).toBe(true);
    });

    it('should return true for a duck-typed signal from another realm', () => {
      // A plain object standing in for a signal whose realm is not this one
      // (e.g. an iframe's AbortSignal): `instanceof` would fail here.
      const foreignSignal = {
        aborted: false,
        addEventListener() {}
      };
      expect(isAbortSignal(foreignSignal)).toBe(true);
    });

    it('should return false for non-signals', () => {
      expect(isAbortSignal(undefined)).toBe(false);
      expect(isAbortSignal(null)).toBe(false);
      expect(isAbortSignal({})).toBe(false);
      expect(isAbortSignal({aborted: false})).toBe(false);
      expect(isAbortSignal(() => {})).toBe(false);
    });

    it('should let stableHash hash a duck-typed signal as #sig', () => {
      const foreignSignal = {
        aborted: false,
        addEventListener() {}
      };
      expect(stableHash(foreignSignal)).toBe('#sig');
      expect(stableHash({signal: foreignSignal})).toBe(
        stableHash({signal: new AbortController().signal})
      );
    });
  });

  describe('stripVolatile', () => {
    it('should strip AbortSignals at every depth', () => {
      const controller = new AbortController();
      expect(stripVolatile(controller.signal)).toBeUndefined();
      expect(stripVolatile([1, controller.signal])).toEqual([1]);
      expect(stripVolatile({a: {signal: controller.signal, b: 2}})).toEqual({
        a: {b: 2}
      });
      expect(
        stripVolatile([{sig: controller.signal}, [controller.signal]])
      ).toEqual([{}, []]);
    });

    it('should drop undefined-valued keys recursively', () => {
      expect(stripVolatile({a: undefined, b: 1})).toEqual({b: 1});
      expect(stripVolatile({a: {b: undefined, c: undefined}})).toEqual({
        a: {}
      });
      // a nested object that strips to empty still occupies its slot
      expect(stripVolatile([0, {x: undefined}])).toEqual([0, {}]);
    });

    it('should normalize loader-side and view-side args to one hash', () => {
      // The multi-channel contract: the loader passes the schema output
      // (no key for the defaulted field), the view passes its state object
      // (undefined property) plus the signal a useRun rerun attached.
      const loaderArgs = [{offset: 0, limit: 10}];
      const viewArgs = [
        {offset: 0, limit: 10, tag: undefined},
        new AbortController().signal
      ];
      expect(stableHash(stripVolatile(loaderArgs))).toBe(
        stableHash(stripVolatile(viewArgs))
      );
      // and a different real field still separates the keys
      expect(stableHash(stripVolatile(loaderArgs))).not.toBe(
        stableHash(stripVolatile([{offset: 10, limit: 10}]))
      );
    });

    it('should strip cross-realm (duck-typed) signals', () => {
      const foreignSignal = {
        aborted: false,
        addEventListener() {}
      };
      expect(stripVolatile([foreignSignal, 'x'])).toEqual(['x']);
      expect(stripVolatile({signal: foreignSignal})).toEqual({});
    });

    it('should keep undefined array slots positional', () => {
      expect(stripVolatile([undefined, 1])).toEqual([undefined, 1]);
      expect(stripVolatile([1, undefined])).not.toEqual([1]);
    });

    it('should pass primitives and Map/Set contents through', () => {
      expect(stripVolatile(1)).toBe(1);
      expect(stripVolatile('a')).toBe('a');
      expect(stripVolatile(null)).toBe(null);
      const map = new Map([['a', 1]]);
      expect(stripVolatile(map)).toBe(map);
      const set = new Set([1]);
      expect(stripVolatile(set)).toBe(set);
    });
  });
});
