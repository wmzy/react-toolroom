export type MetricChannel = 'dedup' | 'abort' | 'inject';

export type LogEntry = {
  id: number;
  text: string;
};

export type Report = {
  count: number;
  at: string;
};

export type Ticker = {
  tick: number;
  at: string;
};

export type FocusStat = {
  count: number;
  at: string;
};

export type Detail = {
  id: number;
  at: string;
};

export type ProbeStat = {
  seq: number;
  at: string;
};
