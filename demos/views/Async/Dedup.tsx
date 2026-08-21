import {useState} from 'react';
import {
  useDedup,
  useInitialLoading,
  useInjectable,
  useLoading,
  useResult
} from 'react-toolroom/async';
import {section} from '@/util/styles';
import {fetchReport} from '@/services/metrics';
import MetricLog from '@/components/MetricLog';

export default function Dedup() {
  const [clicks, setClicks] = useState(0);
  const loadReport = useInjectable(fetchReport);
  useDedup(loadReport);
  const initialLoading = useInitialLoading(loadReport);
  const loading = useLoading(loadReport);
  const report = useResult(loadReport);

  const onClick = () => {
    setClicks(clicks + 1);
    loadReport();
  };

  return (
    <section className={section}>
      <h2>请求去重 useDedup</h2>
      <p>接口耗时 2 秒。请求进行中时连点按钮，并发调用会合并为一次真实请求：</p>
      <button type='button' onClick={onClick}>
        获取报表
      </button>
      <p>
        已点击 {clicks} 次，实际发出请求 {report?.count ?? 0} 次
      </p>
      {initialLoading && <p>首次加载中...</p>}
      {!initialLoading && loading && <p>请求中，并发调用已合并...</p>}
      {report && <p>报表生成于 {report.at}</p>}
      <MetricLog channel='dedup' />
    </section>
  );
}
