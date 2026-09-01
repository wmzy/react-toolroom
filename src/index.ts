/**
 * The main module of this package. It includes the basic functions.
 * @module .
 */

export {default as memo, memoBase, defaultTestEvent} from './memo';
export {default as createMemoryCacheProvider} from './memory-cache-provider';
export {stableHash, isAbortSignal} from './util';
export type {Func, CacheProvider, CacheResult, CacheEvent} from './types';
