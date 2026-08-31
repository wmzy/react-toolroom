// CacheProvider 方差回归：成员一律方法简写——strictFunctionTypes 下方法参数
// 按双变检查，具体元组实例化（CacheProvider<Article, [string]>）因此可赋值
// 给宽泛槽位（CacheProvider<any, any[]>）。此前属性签名（箭头函数型）按严格
// 逆变检查，any[] → [string] 因元组长度不匹配失败，宽注册表被迫弱化成
// K = any（painless decisions.md 第 9 条的 QueryFn 品牌值只能收 unknown 的
// 根因）。本文件的编译期断言由 `npm run typecheck` 强制执行——vitest 只转译
// 不查类型；运行时用例保证文件在 vitest 里也是真实测试。
// 从发布入口导入（经 vitest alias 指回 src），与 recipes 的漂移测试同款，
// 顺带守住类型必须从 'react-toolroom/async' 公开导出。
import {describe, expect, it} from 'vitest';
import {
  createMemoryCacheProvider,
  createMutationBinder,
  invalidate,
  type BoundMutation,
  type CacheProvider,
  type CreateMutationBinder,
  type MutationSpec
} from 'react-toolroom/async';

type Article = {slug: string; title: string};

// 消费方在 CacheProvider 之上收紧的形状（与 painless EntityCache 同构）。
// mutation 必须同样用方法简写：属性签名声明的成员仍按严格逆变检查（见
// 文末反例）。
type EntityCache<T, K extends unknown[]> = CacheProvider<T, K> & {
  mutation<Args extends any[], Resp>(
    spec: (...args: Args) => MutationSpec<T, K, Args, Resp>
  ): BoundMutation<Args, Resp>;
};

// createMemoryCacheProvider + createMutationBinder 组装出真实的 EntityCache：
// 类型与运行时都是真值，无需 declare 替身。
const makeEntityCache = <T, K extends unknown[]>(
  cache: CacheProvider<T, K>
): EntityCache<T, K> => ({...cache, ...createMutationBinder(cache)});

const articleCache = makeEntityCache(
  createMemoryCacheProvider<Article, [string]>({})
);

// ---- 编译期断言（npm run typecheck 强制）----------------------------------
// 库层：具体实例化 → 宽泛槽位。修复前报「Target requires 1 element(s)
// but source may have fewer」。
const wideDirect: CacheProvider<any, any[]> = createMemoryCacheProvider<
  Article,
  [string]
>({});
const wideEntity: EntityCache<any, any[]> = articleCache;
const wideBinder: CreateMutationBinder<any, any[]> = createMutationBinder(
  createMemoryCacheProvider<Article, [string]>({})
);

// painless 的 QueryFn 品牌模式（decisions.md 第 9 条的直接受害者）：修复后
// 品牌值可收回 EntityCache<T, K> 而非 unknown。Symbol() 的 const 声明在
// TS 里自动收窄为 unique symbol——类型是品牌，运行时是真值。
const bound = Symbol('bound');
type QueryFn<T, K extends unknown[]> = ((
  ...args: [...K, signal?: AbortSignal]
) => Promise<T>) & {
  [bound]: EntityCache<T, K>;
};
const bindQueryFn = <T, K extends unknown[]>(
  fetch: (...args: [...K, signal?: AbortSignal]) => Promise<T>,
  cache: EntityCache<T, K>
): QueryFn<T, K> => Object.assign(fetch, {[bound]: cache});
const getCache = (queryFn: QueryFn<any, any[]>): EntityCache<any, any[]> =>
  queryFn[bound];

describe('CacheProvider 方差：具体元组实例化可赋值给宽泛槽位', () => {
  it('宽槽位持有具体 cache 且行为不变', () => {
    const registry: CacheProvider<any, any[]>[] = [
      articleCache,
      wideEntity,
      wideDirect
    ];
    articleCache.set(['a'], {slug: 'a', title: 'A'});
    expect(registry[0].get(['a'])).toEqual([
      {slug: 'a', title: 'A'},
      expect.any(Number)
    ]);
    expect(wideBinder.mutation).toBeTypeOf('function');
  });

  it('具体 QueryFn 流经 QueryFn<any, any[]> 收口取回的仍是原 cache', () => {
    const fetchArticle = (slug: string) => Promise.resolve({slug, title: 'A'});
    const queryFn = bindQueryFn(fetchArticle, articleCache);
    // 传参即断言：QueryFn<Article, [string]> → QueryFn<any, any[]>，品牌值
    // EntityCache<Article, [string]> → EntityCache<any, any[]>
    const cache: EntityCache<any, any[]> = getCache(queryFn);
    expect(cache).toBe(articleCache);
  });

  it('双变不弱化 invalidates 元组的前缀校验', () => {
    // 正例：字符串前缀匹配 [string] 键元组
    expect(() => invalidate([[articleCache, 'a']])).not.toThrow();
    // @ts-expect-error 数字前缀对 [string] 键元组仍拒绝
    invalidate([[articleCache, 123]]);
  });

  it('反例存档：mutation 若按属性签名声明，严格逆变即复活', () => {
    type PropertyMutationCache<T, K extends unknown[]> = CacheProvider<T, K> & {
      mutation: <Args extends any[], Resp>(
        spec: (...args: Args) => MutationSpec<T, K, Args, Resp>
      ) => BoundMutation<Args, Resp>;
    };
    const propCache: PropertyMutationCache<Article, [string]> = articleCache;
    // @ts-expect-error 属性签名成员按严格逆变检查：any[] → [string] 失败
    const propWide: PropertyMutationCache<any, any[]> = propCache;
    expect(propWide).toBe(propCache);
  });
});
