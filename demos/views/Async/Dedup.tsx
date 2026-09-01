import {useState} from 'react';
import {createMemoryCacheProvider} from 'react-toolroom';
import {
  useCache,
  useInitialLoading,
  useInjectable,
  useLoading,
  useResult
} from 'react-toolroom/async';
import {section} from '@/util/styles';
import {fetchReport} from '@/services/metrics';
import {type Report} from '@/types/metrics';
import MetricLog from '@/components/MetricLog';

// 去重是缓存 provider 的职责：`load` 为每个键维护一个 in-flight 槽，
// 并发调用共享同一个 promise，底层请求只发出一次。
const reportCache = createMemoryCacheProvider<Report, []>({cacheTime: 60000});

export default function Dedup() {
  const [clicks, setClicks] = useState(0);
  const loadReport = useInjectable(fetchReport);
  useCache(loadReport, reportCache);
  const initialLoading = useInitialLoading(loadReport);
  const loading = useLoading(loadReport);
  const report = useResult(loadReport);

  const onClick = () => {
    setClicks(clicks + 1);
    loadReport();
  };

  return (
    <section className={section}>
      <h2>请求去重 createMemoryCacheProvider</h2>
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
