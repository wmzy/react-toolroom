/**
 * opts.persist — createMemoryCacheProvider 的 localStorage 持久化。
 *
 * 契约移植自 painless 模板侧钉住的 attachPersistence 语义（模板
 * src/util/useQuery.ts），官方化为 provider 工厂选项：{v, data} 版本
 * 门禁 + 形状粗验、hydrate 保留 cachedAt（重启后按真实年龄过
 * staleTime）、事件镜像写盘（写前 diff 一轮收敛）、跨 tab 只清不
 * hydrate、clear 写空表 + removeItem 兜底、enabled 挂起（模板 mock
 * always 语义的库侧挂点）。
 *
 * test/setup.ts 把 jsdom 的 localStorage 换成了 no-op vi.fn()，本组
 * 每个用例换上真实的内存 Storage；storage-event 派发还原浏览器
 * 「其它文档改动才广播」的行为（jsdom 不自动广播）。storage 监听
 * 与 provider 同生命周期不摘除，用例间靠唯一键隔离。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, render, waitFor} from '@testing-library/react';
import {
  createMemoryCacheProvider,
  stableHash,
  useCache,
  useInjectable,
  useResult,
  useRun
} from '../src/async';

// A minimal spec-compliant Storage, so the persistence path runs against
// a store that actually reads back what was written. Write failures are
// simulated by making this instance's setItem throw (quota/privacy).
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    length: 0,
    key: () => null,
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear()
  };
}

// A controllable promise — resolves only when the test says so.
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return {promise, resolve};
}

const setupStorage = globalThis.localStorage;
let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
  globalThis.localStorage = storage;
});

afterEach(() => {
  globalThis.localStorage = setupStorage;
  vi.restoreAllMocks();
});

describe('createMemoryCacheProvider persist', () => {
  it('round-trip：写入落盘 {v, data}；新 provider 同键 hydrate 回同值且 cachedAt 保留', () => {
    const KEY = 'rt:persist:roundtrip';
    const writer = createMemoryCacheProvider<string[], []>({
      persist: {key: KEY}
    });
    writer.set([], ['tag-a', 'tag-b']);

    // set 事件同步驱动镜像落盘；盘上是版本包 {v, data}：v 是 hydrate
    // 门禁，data 是 dehydrate 表（hashed key → [value, cachedAt]，cachedAt
    // 为写入毫秒时间戳——staleness 计算的原材料）
    const raw = storage.getItem(KEY);
    expect(raw).toBeDefined();
    const stored = JSON.parse(raw!);
    expect(stored.v).toBe(1);
    expect(stored.data[stableHash([])]).toEqual([
      ['tag-a', 'tag-b'],
      expect.any(Number)
    ]);
    const cachedAt = stored.data[stableHash([])][1] as number;

    // 模拟重启：全新 provider 读同一键。hydrate 合并语义保留盘上
    // cachedAt——重启后条目按真实年龄计，天然 stale，消费侧旧值先行 +
    // 后台重验证（SWR），陈旧数据不会冒充新鲜值
    const reader = createMemoryCacheProvider<string[], []>({
      persist: {key: KEY}
    });
    const entry = reader.peek!([]);
    expect(entry?.value).toEqual(['tag-a', 'tag-b']);
    expect(entry?.cachedAt).toBe(cachedAt);
  });

  it('clear 擦盘：先镜像写空表、后 removeItem 兜底——内存与盘同清', () => {
    const KEY = 'rt:persist:clear';
    const cache = createMemoryCacheProvider<string[], []>({
      persist: {key: KEY}
    });
    cache.set([], ['tag']);
    expect(storage.getItem(KEY)).not.toBeNull();

    cache.clear();
    // 内存与盘同清（removeItem 兜底：即使空表写回被配额吞掉，键也已
    // 摘除）——下个会话冷启动不得 hydrate 回旧数据
    expect(cache.snapshot!()).toEqual([]);
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('单键 delete 同步镜像：盘上表随之收窄', () => {
    const KEY = 'rt:persist:delete';
    const cache = createMemoryCacheProvider<string, [string]>({
      persist: {key: KEY}
    });
    cache.set(['a'], 'v1');
    cache.set(['b'], 'v2');
    cache.delete(['a']);

    const stored = JSON.parse(storage.getItem(KEY)!);
    expect(Object.keys(stored.data)).toEqual([stableHash(['b'])]);
    expect(stored.data[stableHash(['b'])]).toEqual(['v2', expect.any(Number)]);
  });

  it('坏 JSON / 坏形状静默降级：不抛、cache 空开始、盘上坏数据不清（等覆写）', () => {
    // 坏 JSON：模块加载路径上不允许存储层炸掉——静默丢弃，cache 空开始
    const BAD1 = 'rt:persist:bad-json';
    storage.setItem(BAD1, '{not json');
    const c1 = createMemoryCacheProvider<string[], []>({
      persist: {key: BAD1}
    });
    expect(c1.snapshot!()).toEqual([]);

    // 坏形状（data 值不是 [value, cachedAt] 二元组）：粗验不合格整体丢弃
    const BAD2 = 'rt:persist:bad-shape';
    const bad2 = JSON.stringify({v: 1, data: {k: ['v']}});
    storage.setItem(BAD2, bad2);
    const c2 = createMemoryCacheProvider<string[], []>({
      persist: {key: BAD2}
    });
    expect(c2.snapshot!()).toEqual([]);

    // 降级路径不写盘：盘上坏数据原样保留，等下次真实 set 的镜像覆写。
    // 读侧丢弃 ≠ 写侧擦除——避免 hydrate 失败时误清用户数据
    expect(storage.getItem(BAD1)).toBe('{not json');
    expect(storage.getItem(BAD2)).toBe(bad2);
  });

  it('版本门禁：{v, data} 才 hydrate；旧格式（裸表）与版本不符整体丢弃且不清盘', () => {
    // 旧格式：v 引入前的裸 dehydrate 表（历史镜像）。版本门禁不认 →
    // 整体丢弃静默重来，刻意不做跨版本迁移（缓存可随时重建，迁移路径
    // 的维护成本高于一次冷启动重拉）
    const OLD = 'rt:persist:old';
    const oldPayload = JSON.stringify({
      [stableHash([])]: [['legacy-tag'], Date.now()]
    });
    storage.setItem(OLD, oldPayload);
    const cOld = createMemoryCacheProvider<string[], []>({
      persist: {key: OLD}
    });
    expect(cOld.peek!([])).toBeUndefined(); // 未 hydrate 进内存
    expect(storage.getItem(OLD)).toBe(oldPayload); // 读侧丢弃 ≠ 写侧擦除

    // 版本不符：未来/未知版本的载荷同样整体丢弃（手改或前滚后回滚）
    const FUTURE = 'rt:persist:future';
    storage.setItem(
      FUTURE,
      JSON.stringify({v: 99, data: {[stableHash([])]: [['x'], Date.now()]}})
    );
    const cFuture = createMemoryCacheProvider<string[], []>({
      persist: {key: FUTURE}
    });
    expect(cFuture.peek!([])).toBeUndefined();

    // 当前版本 {v: 1, data}：hydrate 生效，value 与 cachedAt 均保留
    const CUR = 'rt:persist:v1';
    const cachedAt = Date.now();
    storage.setItem(
      CUR,
      JSON.stringify({v: 1, data: {[stableHash([])]: [['tag'], cachedAt]}})
    );
    const cCur = createMemoryCacheProvider<string[], []>({
      persist: {key: CUR}
    });
    expect(cCur.peek!([])).toEqual({value: ['tag'], cachedAt});

    // 自定义 version：门禁跟随选项值（schema 演进时升版本即弃旧盘）
    const CUSTOM_OK = 'rt:persist:v7-ok';
    storage.setItem(
      CUSTOM_OK,
      JSON.stringify({v: 7, data: {[stableHash([])]: [['tag'], cachedAt]}})
    );
    const cCustom = createMemoryCacheProvider<string[], []>({
      persist: {key: CUSTOM_OK, version: 7}
    });
    expect(cCustom.peek!([])).toEqual({value: ['tag'], cachedAt});

    const CUSTOM_BAD = 'rt:persist:v7-bad';
    storage.setItem(
      CUSTOM_BAD,
      JSON.stringify({v: 1, data: {[stableHash([])]: [['tag'], cachedAt]}})
    );
    const cMis = createMemoryCacheProvider<string[], []>({
      persist: {key: CUSTOM_BAD, version: 7}
    });
    expect(cMis.peek!([])).toBeUndefined();
  });

  it('enabled 挂起：创建期不 hydrate、事件不落盘；恢复后下次写盘补全量表；挂起不拦 clear 擦盘', () => {
    // enabled=false 是「本缓存不碰盘」：创建期 hydrate 一并跳过
    const KEY = 'rt:persist:suspend';
    const seeded = JSON.stringify({
      v: 1,
      data: {[stableHash([])]: [['old'], Date.now()]}
    });
    storage.setItem(KEY, seeded);
    let on = false;
    const cache = createMemoryCacheProvider<string[], []>({
      persist: {key: KEY, enabled: () => on}
    });
    expect(cache.peek!([])).toBeUndefined();

    // 挂起期间只拦镜像落盘：内存缓存照常更新，盘上镜像原样不动
    // （模板 mock always 语义：宁少写不写脏，漏写由下次写盘补上）
    cache.set([], ['faker-tag']);
    expect(cache.peek!([])?.value).toEqual(['faker-tag']);
    expect(storage.getItem(KEY)).toBe(seeded);

    // 挂起不拦擦盘：clear 的 removeItem 兜底不经 enabled——挂起窗口里
    // 登出照样把盘擦干净
    const KEY2 = 'rt:persist:suspend-wipe';
    const cache2 = createMemoryCacheProvider<string[], []>({
      persist: {key: KEY2, enabled: () => false}
    });
    cache2.set([], ['x']);
    expect(storage.getItem(KEY2)).toBeNull(); // 挂起期从未落盘
    cache2.clear();
    expect(storage.getItem(KEY2)).toBeNull();
    expect(cache2.snapshot!()).toEqual([]);

    // 恢复（模板对偶：DevTool 关 always 即 clearAllCaches，真实数据随
    // 后 settle）：下一次事件写回全量表
    on = true;
    cache.set([], ['real-tag']);
    const stored = JSON.parse(storage.getItem(KEY)!);
    expect(stored.data[stableHash([])]).toEqual([
      ['real-tag'],
      expect.any(Number)
    ]);
  });

  it('跨 tab 同步：storage 事件清本 tab 内存，消费者 miss 重拉服务端真相', async () => {
    const KEY = 'rt:persist:crosstab';
    const pending = deferred<string[]>();
    const fn = vi
      .fn()
      .mockResolvedValueOnce(['v1'])
      .mockReturnValueOnce(pending.promise);
    const cache = createMemoryCacheProvider<string[], []>({
      persist: {key: KEY}
    });

    function Host() {
      const injectable = useInjectable(fn);
      useCache(injectable, cache, 60000);
      useRun(injectable, []);
      return (
        <span data-testid='result'>{useResult(injectable) ?? 'none'}</span>
      );
    }
    const {findByText} = render(<Host />);
    expect(await findByText('v1')).toBeDefined();

    // 模拟另一 tab 清空镜像：写盘 + 广播。jsdom 不自动跨「文档」广播
    // storage 事件，手动派发 StorageEvent 还原浏览器行为。
    const emptyMirror = JSON.stringify({v: 1, data: {}});
    storage.setItem(KEY, emptyMirror);
    const setItemSpy = vi.spyOn(storage, 'setItem');
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: KEY,
          newValue: emptyMirror
        })
      );
    });

    // 事件 → 本 tab 内存清空 → useCache 被动重验证（delete 事件重跑）
    expect(cache.peek!([])).toBeUndefined();
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));

    // 回环防护：clear 的 delete 事件驱动镜像写回，但写前 diff 发现盘上
    // 已是同一份空表 → 跳过写盘（不依赖浏览器「同值不广播」的实现细
    // 节，链路一轮收敛，不再给其它 tab 制造新事件源）
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();

    // 消费者从服务端重建真相（不是 hydrate 别 tab 的盘上字节）
    await act(async () => {
      pending.resolve(['v2']);
    });
    expect(await findByText('v2')).toBeDefined();
  });

  it('跨 tab 登出擦盘（newValue=null）：本 tab 内存同样清空', () => {
    const KEY = 'rt:persist:crosstab-null';
    const cache = createMemoryCacheProvider<string[], []>({
      persist: {key: KEY}
    });
    cache.set([], ['v1']);
    expect(cache.peek!([])?.value).toEqual(['v1']);

    // 另一 tab 登出擦盘：removeItem 广播 newValue=null——本 tab 不能继续
    // 用旧会话留在内存里的镜像（与冷启动「不得 hydrate 回上个账号
    // 数据」同一语义的会话内对偶）
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: KEY,
        newValue: null
      })
    );
    expect(cache.peek!([])).toBeUndefined();
  });

  it('跨 tab 互写收敛：两个监听 tab 的写盘乒乓经 diff 一轮收敛不死循环', () => {
    // 回环防护的收敛性契约（镜像写盘的写前 diff）：两个 tab 都在监听
    // storage、各自持有镜像写盘回调时，一轮事件→清内存→写回空表之后
    // 盘上稳定——第二个写回 diff 到同值跳过，链路不再产生新写盘（若
    // diff 失效，写回→广播→再清→再写回会无限乒乓）。jsdom 不自动广播
    // storage 事件，手动派发还原浏览器行为；两个 provider 都挂在本
    // window 上、事件同时命中两者，是真实「只有其它 tab 收到」的保守
    // 超集——超集下收敛则真实链路必收敛。
    const KEY = 'rt:persist:pingpong';
    const tabA = createMemoryCacheProvider<string[], []>({
      persist: {key: KEY}
    });
    const tabB = createMemoryCacheProvider<string[], []>({
      persist: {key: KEY}
    });

    // tabA 拿到新数据落盘（真实浏览器此刻会向 tabB 广播）
    tabA.set([], ['v1']);
    expect(tabB.peek!([])).toBeUndefined(); // 未 hydrate 别 tab 的字节
    const mirror = storage.getItem(KEY)!;

    const setItemSpy = vi.spyOn(storage, 'setItem');
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: KEY,
        newValue: mirror
      })
    );

    // 两 tab 各自清内存；clear 的 delete 事件驱动各自的镜像写回空表：
    // 第一个写回发现盘上是 v1 镜像（不同值）→ 落盘；第二个写回 diff
    // 发现盘上已是同一份空表 → 跳过。全链路只多一次写盘（跨 tab 触发
    // 的 clear 不走 removeItem——事件驱动的空表写回才是收敛手段）
    expect(tabA.peek!([])).toBeUndefined();
    expect(tabB.peek!([])).toBeUndefined();
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    const empty = JSON.stringify({v: 1, data: {}});
    expect(storage.getItem(KEY)).toBe(empty);

    // 广播链回环（真实浏览器会把这次空表写盘广播给另一 tab）：再派发
    // 一轮事件，两 tab 再清（已空，no-op）——写回 diff 同值跳过，无新
    // 写盘，链路就此收敛
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: KEY,
        newValue: empty
      })
    );
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(storage.getItem(KEY)).toBe(empty);
  });

  it('写盘失败静默降级：内存照常正确，恢复后下次写盘带上漏写条目', () => {
    const KEY = 'rt:persist:quota';
    const cache = createMemoryCacheProvider<string, [string]>({
      persist: {key: KEY}
    });
    const spy = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    expect(() => cache.set(['x'], 'hello')).not.toThrow(); // 静默降级
    expect(cache.peek!(['x'])?.value).toBe('hello'); // 内存保持正确

    spy.mockRestore();
    cache.set(['y'], 'world'); // 恢复后的写盘重序列化全量表
    const stored = JSON.parse(storage.getItem(KEY)!);
    expect(stored.data[stableHash(['x'])]).toEqual([
      'hello',
      expect.any(Number)
    ]);
    expect(stored.data[stableHash(['y'])]).toEqual([
      'world',
      expect.any(Number)
    ]);
  });

  it('存储不可用退纯内存：探测失败不挂任何持久化行为', () => {
    // 隐私模式 setItem 直接抛：探测失败 → provider 退化为纯内存，
    // 不 hydrate、不落盘、不留探针残渣
    const KEY = 'rt:persist:probe-fail';
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('private mode', 'SecurityError');
    });
    const cache = createMemoryCacheProvider<string, [string]>({
      persist: {key: KEY}
    });
    expect(() => cache.set(['x'], 'hello')).not.toThrow();
    expect(cache.peek!(['x'])?.value).toBe('hello');
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('SSR 无 window：退纯内存，storage 全程未被触碰', () => {
    const KEY = 'rt:persist:ssr';
    vi.stubGlobal('window', undefined);
    try {
      const cache = createMemoryCacheProvider<string, [string]>({
        persist: {key: KEY}
      });
      cache.set(['x'], 'hello');
      expect(cache.peek!(['x'])?.value).toBe('hello');
      // storage was never touched — no probe, no mirror write
      expect(storage.getItem(KEY)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GC 过期同样镜像：被回收的条目不会在下次冷启动复活', async () => {
    vi.useFakeTimers();
    const KEY = 'rt:persist:gc';
    const cache = createMemoryCacheProvider<string, [string]>({
      cacheTime: 1000,
      persist: {key: KEY}
    });
    cache.set(['doomed'], 'dead');
    expect(JSON.parse(storage.getItem(KEY)!).data).toEqual({
      [stableHash(['doomed'])]: ['dead', expect.any(Number)]
    });

    // 无消费者的写入走 debounce sweep 通道回收（router-loader 通道）；
    // 逐条 GC 的 delete 事件照常驱动镜像——盘上不残留已回收条目
    vi.advanceTimersByTime(1001);
    await vi.waitFor(() => expect(cache.snapshot!()).toEqual([]));
    expect(storage.getItem(KEY)).toBe(JSON.stringify({v: 1, data: {}}));

    vi.useRealTimers();
  });
});

// 不传 persist：storage 全程无人触碰（纯新增选项，缺省行为不变）。
describe('createMemoryCacheProvider without persist', () => {
  it('缺省不碰 storage', () => {
    const KEY = 'rt:persist:absent';
    const cache = createMemoryCacheProvider<string[], []>({});
    cache.set([], ['x']);
    cache.clear();
    expect(storage.getItem(KEY)).toBeNull();
  });
});
