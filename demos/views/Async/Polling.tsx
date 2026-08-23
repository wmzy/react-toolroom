import {useState} from 'react';
import {
  useInjectable,
  useLoading,
  usePolling,
  useResult,
  useRun
} from 'react-toolroom/async';
import {section} from '@/util/styles';
import {fetchTicker} from '@/services/metrics';

// hooks 不能条件调用，所以用开关控制子组件的挂载来启停轮询。
function Ticker() {
  const loadTicker = useInjectable(fetchTicker);
  useRun(loadTicker, []);
  usePolling(loadTicker, 3000);
  const loading = useLoading(loadTicker);
  const ticker = useResult(loadTicker);

  return (
    <p>
      {loading
        ? '请求中...'
        : `最新数据：第 ${ticker?.tick ?? 0} 次，更新于 ${ticker?.at ?? '-'}`}
    </p>
  );
}

export default function Polling() {
  const [enabled, setEnabled] = useState(false);

  return (
    <section className={section}>
      <h2>轮询 usePolling</h2>
      <p>开启后每 3 秒请求一次；上一次请求未完成时自动跳过，页面隐藏时暂停。</p>
      <label>
        <input
          type='checkbox'
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        开启轮询
      </label>
      {enabled && <Ticker />}
    </section>
  );
}
