import {sleep} from '@/util';
import {
  type Detail,
  type FocusStat,
  type LogEntry,
  type MetricChannel,
  type Report,
  type Ticker
} from '@/types/metrics';

// —— 服务端视角的事件日志：把"真实发出的请求"广播给订阅它的组件 ——
let logSeq = 0;
const listeners = new Map<MetricChannel, Set<(entry: LogEntry) => void>>();

export function subscribeMetrics(
  channel: MetricChannel,
  fn: (entry: LogEntry) => void
) {
  const set = listeners.get(channel) ?? new Set();
  set.add(fn);
  listeners.set(channel, set);
  return () => {
    set.delete(fn);
  };
}

function log(channel: MetricChannel, text: string) {
  const entry = {id: ++logSeq, text};
  listeners.get(channel)?.forEach((fn) => fn(entry));
}

function now() {
  return new Date().toLocaleTimeString();
}

// —— 去重演示：耗时 2 秒的报表接口 ——
let reportCount = 0;

export async function fetchReport(): Promise<Report> {
  reportCount++;
  log('dedup', `真实请求发出，共计第 ${reportCount} 次`);
  await sleep(2000);
  return {count: reportCount, at: now()};
}

// —— 轮询演示：每次返回递增的序号 ——
let tick = 0;

export async function fetchTicker(): Promise<Ticker> {
  await sleep(500);
  tick++;
  return {tick, at: now()};
}

// —— 焦点重验证演示 ——
let focusCount = 0;

export async function fetchFocusStat(): Promise<FocusStat> {
  await sleep(1000);
  focusCount++;
  return {count: focusCount, at: now()};
}

// —— 取消演示：耗时 3 秒、支持 AbortSignal 的详情接口 ——
let detailSeq = 0;

export async function fetchDetail(
  id: number,
  signal: AbortSignal
): Promise<Detail> {
  const seq = ++detailSeq;
  log('abort', `请求 #${seq}（商品 ${id}）发出`);
  await sleep(3000);
  if (signal.aborted) {
    log('abort', `请求 #${seq}（商品 ${id}）已取消`);
    throw new DOMException('The request was aborted.', 'AbortError');
  }
  log('abort', `请求 #${seq}（商品 ${id}）完成`);
  return {id, at: now()};
}
