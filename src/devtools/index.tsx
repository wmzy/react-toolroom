/**
 * Zero-dependency devtools panel for the injection system — the UI layer on
 * top of `subscribeInjectEvents`. It ships as the separate
 * `react-toolroom/devtools` entry, so importing it never adds anything to
 * the core or async bundles.
 *
 * Rendering is dependency-free by design: plain React state plus inline
 * style objects — no CSS file, no class names, no external component.
 */
import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type {CSSProperties} from 'react';
import {subscribeInjectEvents} from '../async';
import type {AsyncFunc, CacheEvent} from '../async';
// The named registry is the panel's discovery channel for injectables
// created inside preset hooks; it lives next to useInjectable and is
// deliberately not re-exported from the package entries.
import {getNamedInjectables, subscribeNamedInjectables} from '../async/inject';
// The Refetch button swallows replay rejections: the failure is already
// recorded by the log itself (the replay re-enters the observer chain).
// `isAbortSignal` ducks-types the trailing-signal probe below across
// realms, matching the core's own detection.
import {isAbortSignal, noop} from '../util';

/** Max characters shown per args/result summary cell. */
const SUMMARY_LIMIT = 80;

/** Stable empty default of the `injectables` prop. */
const EMPTY_INJECTABLES: readonly AsyncFunc[] = [];

// Observation must attach before any component's mount effects may fire a
// call. Insertion effects of the whole tree complete before the first
// passive effect, so a panel mounted in the same commit as a named
// injectable still sees its first call — whichever order they sit in the
// tree. React 16.8/17 lack the hook and fall back to useEffect (they have
// no insertion phase; the same-commit race is simply unavoidable there).
const useObserve: typeof useEffect =
  typeof useInsertionEffect === 'function' ? useInsertionEffect : useEffect;

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
 * The shared engine of the panel and `useInjectLog`: subscribes to the
 * given injectables — and, with `includeRegistry`, to every live named
 * injectable — and keeps the last `limit` settle events in component
 * state.
 *
 * `injectables` is compared by identity, so pass a referentially stable
 * array (module constant or `useMemo`) — an inline literal would detach and
 * re-attach the observers on every render of the caller.
 */
function useInjectEvents(
  injectables: readonly AsyncFunc[],
  limit: number,
  includeRegistry = false
): InjectLog {
  const [events, setEvents] = useState<InjectLogEvent[]>([]);
  const seqRef = useRef(0);

  useObserve(() => {
    // Identity-keyed stops: one injectable may arrive both through the
    // `injectables` prop and the registry — it still gets exactly one
    // observer.
    const stops = new Map<AsyncFunc, () => void>();
    const attach = (fn: AsyncFunc) => {
      if (stops.has(fn)) return;
      stops.set(
        fn,
        subscribeInjectEvents(fn, {
          // Only settled calls are recorded: an in-flight row would need a
          // second state machine without adding insight — `duration` and
          // the settle payload already tell the whole story.
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
    };
    injectables.forEach(attach);
    let stopRegistryChanges: (() => void) | undefined;
    if (includeRegistry) {
      // Named members come and go with their components. Sync inside the
      // membership notification — not after a re-render — so a
      // late-mounted injectable's first call, fired from its own mount
      // effects, is already observed. Detached members keep their
      // in-flight settle events: the observer closure outlives its chain
      // entry.
      const sync = () => {
        const live = new Set(getNamedInjectables() as AsyncFunc[]);
        live.forEach(attach);
        for (const [fn, stop] of stops) {
          if (!live.has(fn) && !injectables.includes(fn)) {
            stop();
            stops.delete(fn);
          }
        }
      };
      sync();
      stopRegistryChanges = subscribeNamedInjectables(sync);
    }
    return () => {
      stopRegistryChanges?.();
      stops.forEach((stop) => stop());
    };
    // `limit` and `includeRegistry` rewire deliberately (a new limit or
    // channel needs fresh observers); `setEvents`/`seqRef` are stable.
  }, [injectables, limit, includeRegistry]);

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
  /** Injectables (from `useInjectable`) to watch directly. Keep the array
   * identity stable — module constant or `useMemo` — so observers are not
   * re-wired on every render of the caller. Omit the prop to watch the
   * named registry instead: every live `useInjectable(fn, {name})`, the
   * way to observe injectables created inside preset hooks (a `useQuery`
   * composition), whose references never leave the preset. */
  injectables?: readonly AsyncFunc[];
  /** Also watch every live named injectable, in addition to `injectables`.
   * Defaults to `true` when `injectables` is omitted, `false` when it is
   * passed — so existing panels keep watching exactly what they were
   * handed. */
  registry?: boolean;
  /** Max events kept, default 50. */
  limit?: number;
  /** Panel heading, default `'InjectDevTools'`. */
  title?: string;
  /** Caches (e.g. from `createMemoryCacheProvider`) to observe. Same
   * identity caveat as `injectables`; providers without the optional
   * `snapshot` member are silently skipped. Providers implementing
   * `deleteKey` (structural), `delete` (args fallback) and/or `clear` get
   * per-row Remove and per-cache Invalidate buttons. */
  caches?: readonly ObservableCache[];
  /**
   * Optional replay source for the log's Refetch buttons — the same
   * injectables array as `injectables` is the common value. Each entry's
   * name is derived exactly like the log's (`fn.name || 'anonymous'`), so
   * a row matches its source even for anonymous arrows. A Refetch click
   * re-runs the recorded args through the full current wrapper chain — a
   * plain call, so `useCache` consumers still hit the cache and broadcast
   * through the normal result store.
   */
  refetchable?: readonly AsyncFunc[];
};

/**
 * The optional observation surface of a cache provider — feature-detected
 * by the panel, implemented by `createMemoryCacheProvider`.
 */
export type ObservableCache = {
  /** Shallow copy of every entry as `{key, value, cachedAt}`; rows whose
   * raw args tuple is recoverable carry an additive `args` — the fallback
   * Remove path re-hashes it when no structural channel exists. */
  snapshot?: () => {
    key: string;
    value: any;
    cachedAt: number;
    pending?: boolean;
    args?: any[];
  }[];
  /**
   * Fires after any entry mutation with what changed (`set` after writes,
   * `delete` with the removed entries' raw args); returns an unsubscribe.
   */
  subscribe?: (listener: (e: CacheEvent<any[]>) => void) => () => void;
  /**
   * Optional action surface, feature-detected per button: `delete` removes
   * one entry (the row's Remove button — a pure cache write, the mounted
   * `useCache` consumers' passive revalidation decides whether to refetch),
   * `clear` purges everything (the row group's Invalidate button — the
   * same primitive `invalidate([cache])` calls). The parameter is the
   * wide tuple type concrete providers narrow into, so a
   * `CacheProvider<T, [number]>` stays assignable (parameter bivariance).
   */
  delete?: (k: any) => void;
  clear?: () => void;
  /**
   * The structural Remove channel: deletes exactly the entry stored under
   * the hashed `key` a snapshot row carries, immune to the raw tuple drift
   * the `delete(args)` fallback suffers. Preferred when present — the
   * Remove button feature-detects it and skips the miss-verification
   * fallback entirely.
   */
  deleteKey?: (key: string) => void;
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
  warn: {color: '#c62828'},
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
 * watched injectable via `subscribeInjectEvents` and renders the last
 * `limit` settle events — time, function name, status, duration and an
 * args/result summary — as an inline-styled table. Watched are the
 * `injectables` prop and, when `registry` is on (the default with the prop
 * omitted), every live `useInjectable(fn, {name})` instance: registry
 * members are attached and detached synchronously with their components'
 * mounting, so a preset's first call is observed even when it fires from
 * the same commit. Each entry of the optional `caches` prop that
 * implements `snapshot` additionally renders a cache-browsing table (key,
 * age, value summary) that refreshes via the provider's `subscribe`. Mount
 * it on a dev-only render path; it unsubscribes on unmount and stays out
 * of production bundles unless imported.
 *
 * @param {InjectDevToolsProps} props - `injectables`, `registry`, `limit`,
 *   `title`, `caches`, `refetchable`.
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
 * @example
 * ```tsx
 * // No references needed: watch every useInjectable(fn, {name}) — the
 * // way to observe injectables created inside preset hooks.
 * function useTags() {
 *   const fetchTags = useInjectable(fetchTagList, {name: 'fetchTags'});
 *   useRun(fetchTags, []);
 *   return useResult(fetchTags);
 * }
 *
 * function App() {
 *   return import.meta.env.DEV ? <InjectDevTools /> : null;
 * }
 * ```
 */
export function InjectDevTools({
  injectables = EMPTY_INJECTABLES,
  registry,
  limit = 50,
  title = 'InjectDevTools',
  caches,
  refetchable
}: InjectDevToolsProps) {
  const includeRegistry = registry ?? injectables === EMPTY_INJECTABLES;
  const {events, clear} = useInjectEvents(injectables, limit, includeRegistry);
  useCacheChanges(caches);
  // Keys whose Remove click MISSED — the FALLBACK path only: providers
  // without `deleteKey` are addressed by re-hashing the raw args tuple the
  // row carries, the very array reference the setter passed, so an
  // in-place mutation after `set` (a reused array gaining an element)
  // silently drifts the hash off the stored key. Providers with
  // `deleteKey` (the memory provider) are addressed structurally and
  // cannot miss; the fallback verifies against the snapshot and flags the
  // row instead of failing quietly.
  const [missedRemovals, setMissedRemovals] = useState<Set<string>>(
    () => new Set()
  );

  // The Refetch replay source: derived name → live injectable. Rebuilt
  // only when the prop changes; each event row looks its call up at click
  // time, so an entry recorded from an earlier registration still replays
  // through the injectable currently mounted under that name. The name is
  // derived exactly like the log rows', so lookups match by construction.
  const callables = useMemo(() => {
    const byName = new Map<string, AsyncFunc>();
    if (refetchable) {
      for (const call of refetchable) {
        const name = call.name || 'anonymous';
        if (!byName.has(name)) byName.set(name, call);
      }
    }
    return byName;
  }, [refetchable]);

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
              {callables.size > 0 && <th style={styles.th}>Actions</th>}
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
                {callables.size > 0 && (
                  <td style={styles.td}>
                    {(() => {
                      const call = callables.get(event.name);
                      if (!call) return null;
                      return (
                        <button
                          type='button'
                          style={styles.button}
                          aria-label={`Refetch ${event.name}(${event.args
                            .map((arg) => summarize(arg))
                            .join(', ')})`}
                          onClick={() => {
                            // A recorded trailing signal belongs to the
                            // run that produced the row — by replay time
                            // its owner may be gone ({signal: true}
                            // aborts on dep change/unmount), and replaying
                            // an ABORTED signal would fail the call before
                            // it starts. Strip it and replay the logical
                            // args; a still-live signal replays as-is.
                            const last = event.args[event.args.length - 1];
                            const replayArgs =
                              isAbortSignal(last) && last.aborted
                                ? event.args.slice(0, -1)
                                : event.args;
                            void call(...replayArgs).catch(noop);
                          }}
                        >
                          Refetch
                        </button>
                      );
                    })()}
                  </td>
                )}
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
                {cache.clear && <th style={styles.th}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {cache.snapshot().map((entry) => (
                <tr key={entry.key}>
                  <td style={styles.td}>{entry.key}</td>
                  <td style={styles.td}>{formatAge(entry.cachedAt)}</td>
                  <td style={styles.td}>{summarize(entry.value)}</td>
                  {cache.clear && (
                    <td style={styles.td}>
                      {(() => {
                        // Freeze the narrowed tuple for the closure below.
                        const args = entry.args;
                        // Structural address first: a provider with
                        // `deleteKey` removes by the row's hashed key,
                        // recorded at write time — it cannot drift the way
                        // the stored raw tuple can, and rows without a
                        // tuple (SSR hydration) become removable too.
                        // Providers without it fall back to re-hashing the
                        // row's raw tuple.
                        if (!cache.deleteKey && (!cache.delete || !args))
                          return null;
                        // Scoped by cache index: two caches may hold
                        // the same hashed key.
                        const missedKey = `${index}:${entry.key}`;
                        return (
                          <>
                            <button
                              type='button'
                              style={{...styles.button, marginRight: 4}}
                              aria-label={`Remove ${entry.key}`}
                              onClick={() => {
                                if (cache.deleteKey) {
                                  cache.deleteKey(entry.key);
                                  return;
                                }
                                cache.delete!(args);
                                // Fallback verification, by KEY not by
                                // tuple: still present means the tuple's
                                // hash no longer addresses this entry —
                                // flag the row.
                                const stillThere = cache.snapshot!().some(
                                  (row) => row.key === entry.key
                                );
                                setMissedRemovals((prev) => {
                                  if (stillThere === prev.has(missedKey))
                                    return prev;
                                  const next = new Set(prev);
                                  if (stillThere) next.add(missedKey);
                                  else next.delete(missedKey);
                                  return next;
                                });
                              }}
                            >
                              Remove
                            </button>
                            {missedRemovals.has(missedKey) && (
                              <span style={styles.warn}>
                                remove missed (args mutated?)
                              </span>
                            )}
                          </>
                        );
                      })()}
                      <button
                        type='button'
                        style={styles.button}
                        aria-label='Invalidate all entries of this cache'
                        onClick={() => cache.clear!()}
                      >
                        Invalidate
                      </button>
                    </td>
                  )}
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
