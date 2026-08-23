import {sleep} from '@/util';
import {
  type Detail,
  type FocusStat,
  type LogEntry,
  type MetricChannel,
  type ProbeStat,
  type Report,
  type Ticker
} from '@/types/metrics';

// —— 事件日志：服务端记录真实发出的请求；客户端 wrapper 层（洋葱模型 demo）
// 也写入同一日志，订阅它的组件可以对照各层的执行顺序 ——
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

export function logMetric(channel: MetricChannel, text: string) {
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
  logMetric('dedup', `真实请求发出，共计第 ${reportCount} 次`);
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
  logMetric('abort', `请求 #${seq}（商品 ${id}）发出`);
  await sleep(3000);
  if (signal.aborted) {
    logMetric('abort', `请求 #${seq}（商品 ${id}）已取消`);
    throw new DOMException('The request was aborted.', 'AbortError');
  }
  logMetric('abort', `请求 #${seq}（商品 ${id}）完成`);
  return {id, at: now()};
}

// —— 洋葱模型演示：耗时 1 秒的探测接口 ——
let probeSeq = 0;

export async function fetchProbeStat(): Promise<ProbeStat> {
  const seq = ++probeSeq;
  logMetric('inject', `原始函数执行（真实请求 #${seq}）`);
  await sleep(1000);
  return {seq, at: now()};
}
