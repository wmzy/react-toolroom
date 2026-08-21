import {
  createMemoryCacheProvider,
  useCache,
  useFocusRevalidate,
  useInjectable,
  useLoading,
  useResult,
  useRun
} from 'react-toolroom/async';
import {section} from '@/util/styles';
import {fetchFocusStat} from '@/services/metrics';
import {type FocusStat} from '@/types/metrics';

const statCache = createMemoryCacheProvider<FocusStat, any[]>({
  cacheTime: 60000
});

export default function Focus() {
  const loadStat = useInjectable(fetchFocusStat);
  const isStale = useCache(loadStat, statCache, 5000);
  useFocusRevalidate(loadStat);
  useRun(loadStat, []);
  const stat = useResult(loadStat);
  const loading = useLoading(loadStat);

  return (
    <section className={section}>
      <h2>焦点重验证 useFocusRevalidate</h2>
      <p>
        切换到其他标签页（或让窗口失焦）超过 5
        秒后再切回来，窗口重新获得焦点时会自动重新请求； 5
        秒内回来则直接命中缓存，不会发请求。
      </p>
      <p>
        已请求 {stat?.count ?? 0} 次，最近完成于 {stat?.at ?? '-'}
        {isStale && '，数据已过期，后台重新验证中'}
        {!isStale && loading && '，请求中...'}
      </p>
    </section>
  );
}
