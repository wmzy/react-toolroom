/**
 * The main module of this package. It includes the basic functions.
 * @module .
 */

export {default as memo, memoBase, defaultTestEvent} from './memo';
export {default as createMemoryCacheProvider} from './memory-cache-provider';
export {stableHash, isAbortSignal, stripVolatile, hashArgs} from './util';
export type {
  Func,
  CacheProvider,
  CacheResult,
  CacheEvent,
  PersistOptions
} from './types';
