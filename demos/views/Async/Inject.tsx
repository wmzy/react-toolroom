import {useRef, useState} from 'react';
import {
  useInject,
  useInjectBefore,
  useInjectable,
  useLoading,
  useResult,
  useRun
} from 'react-toolroom/async';
import {section} from '@/util/styles';
import {fetchProbeStat, logMetric} from '@/services/metrics';
import MetricLog from '@/components/MetricLog';

// 独立的探测组件：给别的组件创建的 fetcher 挂 wrapper（跨组件注入）。
// 它不需要拥有 useInjectable，只要拿到 injectable 就能包一层；组件卸载时
// wrapper 自动从调用链移除，之后的调用不会再经过这里。
function DevProbe({loadStat}: {loadStat: typeof fetchProbeStat}) {
  const [count, setCount] = useState(0);
  // ref 保证并发调用时序号也不重复；state 只负责触发渲染。
  const seqRef = useRef(0);

  useInject(loadStat, (f) => async () => {
    const seq = ++seqRef.current;
    setCount(seq);
    logMetric('inject', `DevProbe 进入（第 ${seq} 次调用）`);
    const stat = await f();
    logMetric('inject', `DevProbe 返回（结果来自第 ${stat.seq} 次请求）`);
    return stat;
  });

  return <p>DevProbe 挂载中，已探测 {count} 次调用</p>;
}

export default function Inject() {
  const [probeOn, setProbeOn] = useState(true);
  const [elapsed, setElapsed] = useState<number>();

  const loadStat = useInjectable(fetchProbeStat);

  // 注册顺序即洋葱层次：后注册的在外层。withTiming 在 DevProbe 之前注册，
  // 所以 DevProbe 包在 withTiming 外面。
  useInject(loadStat, (f) => async () => {
    logMetric('inject', 'withTiming 进入，开始计时');
    const start = performance.now();
    try {
      return await f();
    } finally {
      const ms = Math.round(performance.now() - start);
      setElapsed(ms);
      logMetric('inject', `withTiming 计时结束，耗时 ${ms}ms`);
    }
  });
  // useInjectBefore 插到链头：不管注册多晚，它永远是最内层、紧贴原始函数。
  useInjectBefore(loadStat, (f) => async () => {
    logMetric('inject', 'useInjectBefore 进入（最内层，紧贴原始函数）');
    return f();
  });

  useRun(loadStat, []);
  const stat = useResult(loadStat);
  const loading = useLoading(loadStat);

  return (
    <section className={section}>
      <h2>跨组件注入 useInject / useInjectBefore</h2>
      <p>
        接口耗时 1 秒，日志记录一次调用穿过的每一层。执行顺序是洋葱模型：
        后注册的 wrapper 在外层——DevProbe 晚于 withTiming
        注册，包在它外面；useInjectBefore 插入链头，虽然注册最晚，
        却永远是最内层、紧贴原始函数。取消勾选卸载 DevProbe，它的 wrapper
        自动移除，日志里从此只剩计时与内层。
      </p>
      <label>
        <input
          type='checkbox'
          checked={probeOn}
          onChange={(e) => setProbeOn(e.target.checked)}
        />
        挂载 DevProbe（跨组件注入）
      </label>
      {probeOn && <DevProbe loadStat={loadStat} />}
      <div>
        <button type='button' onClick={() => loadStat()}>
          刷新
        </button>
        {loading && <span>请求中...</span>}
      </div>
      <p>
        第 {stat?.seq ?? 0} 次请求的结果，更新于 {stat?.at ?? '-'}
        ；withTiming 实测耗时 {elapsed ?? '-'}ms
      </p>
      <MetricLog channel='inject' max={12} />
    </section>
  );
}
