/**
 * Zero-dependency devtools panel for the injection system — the UI layer on
 * top of `subscribeInjectEvents`. It ships as the separate
 * `react-toolroom/devtools` entry, so importing it never adds anything to
 * the core or async bundles.
 *
 * Rendering is dependency-free by design: plain React state plus inline
 * style objects — no CSS file, no class names, no external component.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {CSSProperties} from 'react';
import {subscribeInjectEvents} from '../async';
import type {AsyncFunc} from '../async';

/** Max characters shown per args/result summary cell. */
const SUMMARY_LIMIT = 80;

/**
 * One recorded call of a watched injectable — exactly what `onSettle`
 * reported: `result` and `error` are mutually exclusive, `duration` covers
 * the whole onion chain below the observer (the original function plus
 * every wrapper registered before the subscription), and `at` is the
 * wall-clock settle time.
 */
export type InjectLogEvent = {
  /** Monotonic sequence number; the stable React key (timestamps collide). */
  seq: number;
  /** `fn.name` of the watched injectable, `'anonymous'` when nameless. */
  name: string;
  /** Call arguments as they passed the observer. */
  args: any[];
  /** Resolved value; absent when the call rejected. */
  result?: any;
  /** Rejection reason; absent when the call resolved. */
  error?: any;
  /** Milliseconds from call start to settle. */
  duration: number;
  /** `Date.now()` at settle time. */
  at: number;
};

/** What both the panel and `useInjectLog` return: the log plus a reset. */
type InjectLog = {events: InjectLogEvent[]; clear: () => void};

/**
 * The shared engine of the panel and `useInjectLog`: subscribes to every
 * injectable and keeps the last `limit` settle events in component state.
 *
 * `injectables` is compared by identity, so pass a referentially stable
 * array (module constant or `useMemo`) — an inline literal would detach and
 * re-attach the observers on every render of the caller.
 */
function useInjectEvents(
  injectables: readonly AsyncFunc[],
  limit: number
): InjectLog {
  const [events, setEvents] = useState<InjectLogEvent[]>([]);
  const seqRef = useRef(0);

  useEffect(() => {
    const unsubscribes = injectables.map((fn) =>
      subscribeInjectEvents(fn, {
        // Only settled calls are recorded: an in-flight row would need a
        // second state machine without adding insight — `duration` and the
        // settle payload already tell the whole story.
        onSettle: ({args, result, error, duration}) => {
          setEvents((prev) =>
            [
              ...prev,
              {
                seq: ++seqRef.current,
                name: fn.name || 'anonymous',
                args,
                result,
                error,
                duration,
                at: Date.now()
              }
            ].slice(-limit)
          );
        }
      })
    );
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, [injectables, limit]);

  const clear = useCallback(() => setEvents([]), []);
  return {events, clear};
}

/**
 * Records the last `limit` (default 50) settle events of a single
 * injectable — the headless counterpart of `<InjectDevTools>` for building
 * custom panels: the same `InjectLogEvent` log, your own rendering.
 *
 * @param {AsyncFunc} fn - An injectable function returned by `useInjectable`.
 * @param {number} [limit=50] - Max events kept; older ones are trimmed.
 * @return {InjectLog} `{events, clear}` — the recorded log and a reset.
 * @example
 * ```tsx
 * import {useInjectLog} from 'react-toolroom/devtools';
 *
 * function FetchTrail({fetchUsers}: {fetchUsers: AsyncFunc}) {
 *   const {events, clear} = useInjectLog(fetchUsers, 20);
 *   return (
 *     <ol>
 *       {events.map((event) => (
 *         <li key={event.seq}>
 *           {event.name}({event.args.join(', ')}) →{' '}
 *           {event.error ? `error: ${event.error.message}` : 'ok'} in{' '}
 *           {Math.round(event.duration)}ms
 *         </li>
 *       ))}
 *     </ol>
 *   );
 * }
 * ```
 */
export function useInjectLog(fn: AsyncFunc, limit = 50): InjectLog {
  // Memoized per fn: the subscription effect above keys on array identity,
  // and a fresh `[fn]` per render would churn the wrapper registration.
  const injectables = useMemo(() => [fn], [fn]);
  return useInjectEvents(injectables, limit);
}

export type InjectDevToolsProps = {
  /** Injectables (from `useInjectable`) to watch. Keep the array identity
   * stable — module constant or `useMemo` — so observers are not re-wired
   * on every render of the caller. */
  injectables: readonly AsyncFunc[];
  /** Max events kept, default 50. */
  limit?: number;
  /** Panel heading, default `'InjectDevTools'`. */
  title?: string;
  /** Caches (e.g. from `createMemoryCacheProvider`) to observe. Same
   * identity caveat as `injectables`; providers without the optional
   * `snapshot` member are silently skipped. */
  caches?: readonly ObservableCache[];
};

/**
 * The optional observation surface of a cache provider — feature-detected
 * by the panel, implemented by `createMemoryCacheProvider`.
 */
export type ObservableCache = {
  /** Shallow copy of every entry as `{key, value, cachedAt}`. */
  snapshot?: () => {key: string; value: any; cachedAt: number}[];
  /** Fires after any entry mutation; returns an unsubscribe. */
  subscribe?: (listener: () => void) => () => void;
};

/**
 * Re-renders the panel whenever any observed cache reports a mutation:
 * subscribes once per cache (identity-keyed like `injectables`) and bumps
 * a counter; the render pass then pulls fresh `snapshot()` data.
 */
function useCacheChanges(caches?: readonly ObservableCache[]) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!caches) return;
    const unsubscribes = caches
      .map((cache) => cache.subscribe?.(() => setTick((tick) => tick + 1)))
      .filter((unsubscribe): unsubscribe is () => void => !!unsubscribe);
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, [caches]);
}

const styles: Record<string, CSSProperties> = {
  panel: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.5,
    color: '#222',
    backgroundColor: '#fafafa',
    border: '1px solid #ddd',
    borderRadius: 6,
    padding: 8,
    // A bounded body keeps the panel usable in any layout.
    maxHeight: 320,
    overflowY: 'auto',
    boxSizing: 'border-box'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6
  },
  title: {fontSize: 12},
  button: {
    font: 'inherit',
    cursor: 'pointer',
    padding: '2px 8px',
    border: '1px solid #ccc',
    borderRadius: 4,
    backgroundColor: '#fff'
  },
  empty: {margin: 0, color: '#888'},
  table: {width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed'},
  th: {
    textAlign: 'left',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    padding: '2px 6px',
    borderBottom: '1px solid #ccc'
  },
  td: {
    verticalAlign: 'top',
    overflowWrap: 'anywhere',
    padding: '2px 6px',
    borderBottom: '1px solid #eee'
  }
};

/**
 * A minimal call-trace panel for the injection system: it subscribes every
 * passed injectable via `subscribeInjectEvents` and renders the last
 * `limit` settle events — time, function name, status, duration and an
 * args/result summary — as an inline-styled table. Each entry of the
 * optional `caches` prop that implements `snapshot` additionally renders
 * a cache-browsing table (key, age, value summary) that refreshes via the
 * provider's `subscribe`. Mount it on a dev-only render path; it
 * unsubscribes on unmount and stays out of production bundles unless
 * imported.
 *
 * @param {InjectDevToolsProps} props - `injectables`, `limit`, `title`, `caches`.
 * @example
 * ```tsx
 * import {InjectDevTools} from 'react-toolroom/devtools';
 *
 * function UserList() {
 *   const fetchUsers = useInjectable(fetchList);
 *   useRun(fetchUsers, []);
 *   const users = useResult(fetchUsers);
 *   const watched = useMemo(() => [fetchUsers], [fetchUsers]);
 *
 *   return (
 *     <>
 *       <UserTable users={users} />
 *       {import.meta.env.DEV && (
 *         <InjectDevTools injectables={watched} caches={[userCache]} />
 *       )}
 *     </>
 *   );
 * }
 * ```
 */
export function InjectDevTools({
  injectables,
  limit = 50,
  title = 'InjectDevTools',
  caches
}: InjectDevToolsProps) {
  const {events, clear} = useInjectEvents(injectables, limit);
  useCacheChanges(caches);

  return (
    <section aria-label={title} style={styles.panel}>
      <div style={styles.header}>
        <strong style={styles.title}>{title}</strong>
        <button type='button' style={styles.button} onClick={clear}>
          Clear ({events.length})
        </button>
      </div>
      {events.length === 0 ? (
        <p style={styles.empty}>No calls settled yet.</p>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Time</th>
              <th style={styles.th}>Function</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Duration</th>
              <th style={styles.th}>Args → Result</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.seq}>
                <td style={styles.td}>{formatTime(event.at)}</td>
                <td style={styles.td}>{event.name}</td>
                <td
                  style={{
                    ...styles.td,
                    color: event.error ? '#c62828' : '#2e7d32'
                  }}
                >
                  {event.error ? 'error' : 'ok'}
                </td>
                <td style={styles.td}>{formatDuration(event.duration)}</td>
                <td style={styles.td}>
                  {summarize(event.args)} →{' '}
                  {event.error
                    ? summarize(event.error)
                    : summarize(event.result)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {caches?.map((cache, index) =>
        cache.snapshot ? (
          <table key={index} style={{...styles.table, marginTop: 6}}>
            <thead>
              <tr>
                <th style={styles.th}>Key</th>
                <th style={styles.th}>Age</th>
                <th style={styles.th}>Value</th>
              </tr>
            </thead>
            <tbody>
              {cache.snapshot().map((entry) => (
                <tr key={entry.key}>
                  <td style={styles.td}>{entry.key}</td>
                  <td style={styles.td}>{formatAge(entry.cachedAt)}</td>
                  <td style={styles.td}>{summarize(entry.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null
      )}
    </section>
  );
}

/** Compact, crash-proof cell text: strings stay raw, the rest is JSON. */
function summarize(value: any): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (value instanceof Error) {
    // JSON.stringify(new Error('x')) is '{}' — the message is the payload.
    text = `${value.name}: ${value.message}`;
  } else {
    try {
      // JSON.stringify(undefined) returns undefined, not a string.
      text = JSON.stringify(value) ?? String(value);
    } catch {
      // Circular reference — the coercion label is the best we can show.
      text = String(value);
    }
  }
  return text.length > SUMMARY_LIMIT
    ? `${text.slice(0, SUMMARY_LIMIT - 1)}…`
    : text;
}

// UTC HH:MM:SS.mmm — deterministic across locales and timezones, so only
// the millisecond part ever varies between two events.
function formatTime(at: number): string {
  return new Date(at).toISOString().slice(11, 23);
}

function formatDuration(ms: number): string {
  return `${Math.round(ms)}ms`;
}

// Whole seconds since the entry was cached — cache browsing granularity,
// sub-second jitter would just flicker.
function formatAge(cachedAt: number): string {
  return `${Math.round((Date.now() - cachedAt) / 1000)}s`;
}
