// CacheProvider 方差回归：成员一律方法简写——strictFunctionTypes 下方法参数
// 按双变检查，具体元组实例化（CacheProvider<Article, [string]>）因此可赋值
// 给宽泛槽位（CacheProvider<any, any[]>）。此前属性签名（箭头函数型）按严格
// 逆变检查，any[] → [string] 因元组长度不匹配失败，宽注册表被迫弱化成
// K = any（painless decisions.md 第 9 条的 QueryFn 品牌值只能收 unknown 的
// 根因）。本文件的编译期断言由 `npm run typecheck` 强制执行——vitest 只转译
// 不查类型；运行时用例保证文件在 vitest 里也是真实测试。
// 从发布入口导入（经 vitest alias 指回 src），与 recipes 的漂移测试同款，
// 顺带守住类型必须从 'react-toolroom/async' 公开导出。
import {describe, expect, expectTypeOf, it} from 'vitest';
import {
  createMemoryCacheProvider,
  createMutationBinder,
  invalidate,
  useArgsStatus,
  type ArgsStatus,
  type BoundMutation,
  type CacheProvider,
  type CreateMutationBinder,
  type MutationSpec,
  type MutationStatus
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

// useArgsStatus error 泛型 + useMutation 派生 status：消费方视角的类型
// 契约。编译期断言同样由 typecheck 强制；探测组件从不渲染（体内只做
// 类型收口），运行时用例走非 hook 途径保证 describe 在 vitest 里是真测试。
class ApiError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`api ${code}`);
    this.code = code;
  }
}
const fetchUser = async (id: number) => ({id, name: 'Ada'});

// 探测组件：永不渲染。默认调用形态下 error 即 Error | undefined——
// 消费方不再需要 as 断言（painless useQuery 的 `as Error | undefined`
// 由本断言背书删除）；第二泛型显式收窄。
function ArgsStatusTypeProbe(props: {fn: typeof fetchUser}) {
  const status = useArgsStatus(props.fn, [1]);
  expectTypeOf(status.error).toEqualTypeOf<Error | undefined>();
  expectTypeOf(status.loading).toEqualTypeOf<boolean>();
  expectTypeOf(status.failureCount).toEqualTypeOf<number>();
  const api = useArgsStatus<typeof fetchUser, ApiError>(props.fn, [1]);
  expectTypeOf(api.error).toEqualTypeOf<ApiError | undefined>();
  return null;
}
void ArgsStatusTypeProbe;

describe('useArgsStatus error 泛型与 useMutation status 类型契约', () => {
  it('ArgsStatus 默认实例化可构造，E 实参收窄 error 字段', () => {
    const plain: ArgsStatus = {
      loading: false,
      error: undefined,
      failureCount: 0,
      data: undefined,
      dataUpdatedAt: undefined,
      dataUpdateCount: undefined
    };
    expect(plain.error).toBeUndefined();
    const narrowed: ArgsStatus<ApiError> = {
      ...plain,
      error: new ApiError(418)
    };
    expect(narrowed.error?.code).toBe(418);
  });

  it('MutationStatus.status 是 TanStack 同款四态字面量联合', () => {
    expectTypeOf<MutationStatus['status']>().toEqualTypeOf<
      'idle' | 'pending' | 'success' | 'error'
    >();
    const phases: MutationStatus['status'][] = [
      'idle',
      'pending',
      'success',
      'error'
    ];
    expect(phases).toHaveLength(4);
  });
});
