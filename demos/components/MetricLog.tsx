import {css} from '@linaria/core';
import {useEffect, useState} from 'react';
import {type LogEntry, type MetricChannel} from '@/types/metrics';
import {subscribeMetrics} from '@/services/metrics';

type Props = {
  channel: MetricChannel;
  max?: number;
};

// 展示服务端视角的真实请求日志，用于对比"组件调用了几次"和"请求发出了几次"。
export default function MetricLog({channel, max = 6}: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(
    () =>
      subscribeMetrics(channel, (entry) => {
        setEntries((prev) => [...prev.slice(-(max - 1)), entry]);
      }),
    [channel, max]
  );

  if (!entries.length) return null;

  return (
    <ol
      className={css`
        color: #666;
        font-size: 12px;
      `}
    >
      {entries.map((entry) => (
        <li key={entry.id}>{entry.text}</li>
      ))}
    </ol>
  );
}
