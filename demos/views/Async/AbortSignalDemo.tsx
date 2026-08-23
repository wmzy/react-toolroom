import {useState} from 'react';
import {
  useError,
  useInjectable,
  useLoading,
  useResult,
  useRun
} from 'react-toolroom/async';
import {section} from '@/util/styles';
import {fetchDetail} from '@/services/metrics';
import MetricLog from '@/components/MetricLog';

const PRODUCT_IDS = [101, 102, 103];

export default function AbortSignalDemo() {
  const [id, setId] = useState(PRODUCT_IDS[0]);
  // useRun 的第三个参数开启 {signal: true} 后，每次运行会向函数尾部追加一个
  // AbortSignal，依赖变化或组件卸载时自动 abort，旧请求随之被取消。
  const loadDetail = useInjectable((detailId: number, signal: AbortSignal) =>
    fetchDetail(detailId, signal)
  );
  useRun(loadDetail, [id], {signal: true});
  const loading = useLoading(loadDetail);
  const detail = useResult(loadDetail);
  const error = useError(loadDetail);

  return (
    <section className={section}>
      <h2>请求取消 useRun + AbortSignal</h2>
      <p>
        接口耗时 3
        秒。加载中途切换商品，上一次请求会被自动取消，只有最新一次的结果会生效：
      </p>
      <div>
        {PRODUCT_IDS.map((productId) => (
          <button
            key={productId}
            type='button'
            disabled={productId === id}
            onClick={() => setId(productId)}
          >
            商品 {productId}
          </button>
        ))}
      </div>
      {loading && <p>商品 {id} 加载中...</p>}
      {detail && detail.id === id && (
        <p>
          商品 {detail.id} 详情，更新于 {detail.at}
        </p>
      )}
      {error && <p>上一次请求已取消（{error.name}），等待新请求完成...</p>}
      <MetricLog channel='abort' />
    </section>
  );
}
