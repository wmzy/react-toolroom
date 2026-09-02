# Migrating from TanStack Query

react-toolroom's async layer covers the same ground as TanStack Query —
declarative data fetching, caching, background revalidation, invalidation,
optimistic updates — but it is plain React hooks composed around **your**
functions, not a query-key-driven declarative cache. This page maps the
concepts.

A mental model that transfers: TanStack Query keys a **Query** (an entry in
one big cache) by a `queryKey` tree and attaches observers to it with a
`gcTime` after the last observer unsubscribes. react-toolroom keys a
**cache entry** by the raw arguments tuple you pass to your function, inside
a per-entity `CacheProvider` you create, and reclaims idle entries with the
same two-phase idea — but the cache is per entity, not one global store.

## The core mapping

| TanStack Query | react-toolroom | Notes |
| --- | --- | --- |
| `useQuery({queryKey, queryFn})` | `useCache(fetcher, cache)` + `useInjectable(fetcher)` + `useResult`/`useLoading`/`useError` | The fetcher is a plain function; the hook reads/writes the provider keyed by the call arguments. |
| `queryKey` tree (`['users', id]`) | raw args tuple (`[id]`) + one provider per entity | No key serialization layer — the tuple *is* the key; `stableHash` handles structural hashing (or supply `hash`). |
| one global `QueryClient` | one `createMemoryCacheProvider()` per entity | Providers are module-scope singletons you create and wire explicitly. |
| `queryFn` receives `{queryKey, signal}` | your function receives its args + trailing `AbortSignal` | `useRun(fn, args, {signal: true})` (and the hooks built on it) appends the signal as the trailing argument; cancellation works the same. |
| `enabled: !!id` | conditional rendering / early return, or guard inside the fetcher | No declarative `enabled` — compose hooks the normal React way. |
| `select` | `useResultSelect(fn, select)` | Same idea: derive a slice without breaking cache identity. |
| `placeholderData: keepPreviousData` | default behavior + `usePlaceholderData(fn)` flag | Keeping the previous data on a key change is already the default; the flag tells you WHICH data is on screen. |
| `initialData` / SSR hydration | `dehydrate()` / `hydrate()` on the provider | Server stamps `cachedAt`; client hydrates before first render. |
| `useSuspenseQuery` | `useCache` + `useSuspenseResult` | Suspends only until the FIRST result exists; later results flow in like `useResult`. Throws the in-flight promise, so its rejection reaches the error boundary. The hook never starts the call — the driver (`useRun`) must live outside the boundary, because a suspended subtree never runs its effects. |
| `refetchInterval` | `usePolling(fn, interval, {whenHidden?, args?})` | Timer re-arms on args change; skips a tick while the previous call is pending; pauses while the document is hidden by default — `whenHidden: true` is TanStack's `refetchIntervalInBackground`. A failed tick surfaces through `useError`/`useArgsStatus` even when neither is mounted at tick time; the next successful tick clears it. |
| `refetchOnWindowFocus` | `useFocusRevalidate(fn, {interval?, args?})` | `focus` + `visibilitychange` back to visible. TanStack defaults this to `true` per query (and gates it on staleness); here there is no default — you mount the hook per scenario, every event revalidates, and `interval` throttles (it is not a poll cadence). |
| `refetchOnReconnect` | `useReconnectRevalidate(fn, {interval?, args?})` | Window `online` event, guarded by `navigator.onLine`. Also `true` by default in TanStack; same explicit opt-in and `interval` throttle here. |
| `retry` / exponential backoff | `useRetry(fn, {retries, backoff})` | Preset backoff strategies (`exponential`: 1s, 2s, 4s… / `linear` / custom). |

## Queries: `useQuery` → `useCache`

```tsx
// TanStack
const {data, isPending, error} = useQuery({
  queryKey: ['users', id],
  queryFn: () => api.user(id),
});

// react-toolroom
const userCache = createMemoryCacheProvider<User, [string]>({cacheTime: 60_000});

function useUser(id: string) {
  const fetchUser = useInjectable((id: string, signal: AbortSignal) => api.user(id, signal));
  useCache(fetchUser, userCache);
  const user = useResult(fetchUser, [id]);
  const loading = useLoading(fetchUser, [id]);
  const error = useError(fetchUser, [id]);
  return {user, isPending: loading, error};
}
```

Cache identity is the args tuple: `fetchUser` called with `['u1']` shares one
entry everywhere. On a cache hit the value broadcasts immediately; if it is
older than `staleTime` (default `0`), a background refetch follows (SWR), and
its failure keeps the stale value on screen.

### `gcTime` / `staleTime` semantics

| Concept | TanStack Query | react-toolroom |
| --- | --- | --- |
| Entry lifetime | `gcTime` (default 5 min) after the last observer unsubscribes | `cacheTime` (default `Infinity`) of idle time, measured per entry |
| Mounted observers | query with observers is never collected | entry observed by a mounted `useCache` consumer is exempt until it unmounts (`provider.observe(args, on)`) |
| Activity refresh | every observer attach refreshes the GC timer | every `get`/`peek`/`set`/`load` settle refreshes the entry's `lastUsedAt` |
| No observers at all | entry is garbage after `gcTime` | entry is reclaimed too: every write debounce-schedules a sweep `cacheTime` out, so loader-primed entries with zero components still expire |
| In-flight request | query with fetchStatus `fetching` is not collected | an entry with an in-flight request is never collected |
| Freshness | `staleTime` (default 0) | `staleTime` on `useCache` (default 0) — identical meaning; `cachedAt` is stamped from settle, not request start |
| Forever | `gcTime: Infinity` | `cacheTime: Infinity` (the default) |

Trade-off vs. TanStack's per-query timers: the sweep is one shared deadline
that every access reschedules, so a periodically read entry (polling,
keep-alive) postpones reclamation indefinitely — for itself and for any
other unobserved entries riding the same scan.

`delete` events carry the removed entries' raw args tuples
(`{type: 'delete', deleted: [args]}`), emitted after removal — the analogue
of Query Cache's `removed` event, with args instead of query keys.

## Mutations: `useMutation` → `useMutation` / `cache.mutation`

```tsx
// TanStack
const mutation = useMutation({
  mutationFn: (name: string) => api.rename(name),
  onSuccess: () => queryClient.invalidateQueries({queryKey: ['users']}),
});

// react-toolroom — declare invalidation up front
const [rename] = useMutation(
  useInjectable(api.rename),
  {invalidates: [userCache, [usersCache, 'list-prefix']]} // providers (+ optional args prefix)
);
```

| TanStack | react-toolroom | Notes |
| --- | --- | --- |
| `useMutation({mutationFn})` | `useMutation(mutate, {invalidates, onMutate, onSuccess, onError, onSettled, scope})` | `invalidates` lists the cache providers (or `[provider, ...argsPrefix]` slices) to purge on success. Returns `[mutate, {isMutating, error, failureCount, status}, reset]` — see [Return shape](#return-shape) below. |
| `onMutate(vars)` — may be async, returns the rollback ctx | `onMutate(...args)` | Fires synchronously when `mutate` is called, with the raw args only — no context object, return value ignored. Rollback is not your job: `cache.mutation` does it automatically (see [Optimistic updates](#optimistic-updates) below). |
| `onSuccess(data, vars, ctx)` | `onSuccess(result, ...args)` | `invalidates` purges BEFORE any user callback runs — library plumbing is not hostage to a throwing `onSuccess`. |
| `onError(err, vars, ctx)` | `onError(err, ...args)` | A rejected mutation invalidates nothing. |
| `onSettled(data \| undefined, err, vars, ctx)` | `onSettled(result \| undefined, err, ...args)` | Success passes `(result, undefined, ...args)`; failure passes `(undefined, err, ...args)`. |
| `queryClient.invalidateQueries({queryKey})` | `useInvalidate(fetcher, cache)(...args)` (hook) / `invalidate([targets])` (imperative) | Invalidate by args; a `[provider, ...prefix]` target sweeps every entry whose args start with the prefix. |
| `queryClient.setQueryData(key, updater)` | `cache.patchWhere(pred, updater)` | Batch write with per-entry generation guard. |
| `queryClient.getQueryData(key)` | `cache.peek(args)` / `cache.get(args)` | `peek` never observes or starts requests. |
| `mutation.isPending` | `status === 'pending'` / `isMutating` | Same shape. The tuple's `status` is the full TanStack lifecycle — `'idle' \| 'pending' \| 'success' \| 'error'` — derived on the `isMutating` clock. |
| `mutation.status` / `mutation.reset()` → `idle` | `status` / `reset` | `status` reads `'idle'` before any call and after `reset`, which clears the settled bookkeeping (a call in flight keeps `pending` and still lands). |
| `mutationKey` + serial `scope` | `scope` option | Queue same-scope mutations instead of racing them. |

### Return shape

TanStack splits one behavior across two functions: `mutate` is
fire-and-forget (returns `void`; callbacks ride the options) while
`mutateAsync` returns the promise. react-toolroom merges them — `mutate`
is the injectable itself, so the returned promise resolves with the result
and rejects with the failure, AND the same call feeds the
`{isMutating, error, failureCount, status}` stores. Awaiting callers
branch on the outcome (`rename(id, name).catch(() => {})` opts out of the
rejection); fire-and-forget callers read `error` from the status instead.

The status is injectable-level shared state, not per-hook-instance: every
component tracking the same mutation updates together, and a component
mounted after a call starts from the current values. `status` carries
TanStack's `mutation.status` semantics — `'idle' | 'pending' | 'success' |
'error'` — derived on the `isMutating` clock (a scope-queued call is
`pending` while it waits). `failureCount` and `reset` do have same-named
TanStack counterparts (`mutation.failureCount`, `mutation.reset()`), but
the semantics differ — TanStack's `reset()` restores the whole instance
to its initial `idle` state (clears `data`, `variables`, `error`), while
toolroom's `reset` only clears the settled error/failureCount bookkeeping
(with no call in flight, `status` reads `'idle'` again): it never touches
the ticket sequence, so a call already in flight keeps `pending` and its
ticket valid — the outcome still lands afterwards.

### Optimistic updates

```tsx
// TanStack: onMutate snapshot + onError rollback + onSettled invalidate
useMutation({
  mutationFn: api.rename,
  onMutate: async (next) => {
    await queryClient.cancelQueries({queryKey: ['user', next.id]});
    const prev = queryClient.getQueryData(['user', next.id]);
    queryClient.setQueryData(['user', next.id], next);
    return {prev};
  },
  onError: (_e, vars, ctx) => queryClient.setQueryData(['user', vars.id], ctx?.prev),
  onSettled: () => queryClient.invalidateQueries({queryKey: ['user']}),
});

// react-toolroom: cache.mutation — the pipeline is built in
const favorite = articleCache.mutation((slug: string, on: boolean) => ({
  mutate: () => api.favorite(slug, on),                     // the real request (zero-arg closure)
  key: [slug],                                              // which entry to patch; omit to patch every settled entry via update/apply
  update: (old: Article) => ({...old, favorited: on}),      // applied optimistically
  apply: (old: Article, resp: {favorited: boolean; count: number}) => ({
    ...old,
    favorited: resp.favorited,
    count: resp.count
  })                                                        // reconciled with the response
  // rollback to the pre-mutation value on failure is automatic,
  // and a concurrent write during flight is never clobbered
}));
const [runFavorite] = useMutation(useInjectable(favorite));
```

The `cache.mutation(spec)` binder layers the whole TanStack `onMutate` /
`onError` / `onSettled` ritual into one spec: optimistic `update`, the real
request in `mutate`, response `apply`, automatic rollback with a
generation-guarded identity check.

## DevTools

TanStack Query Devtools → `react-toolroom/devtools`: mount the panel, pass
`caches: [userCache, ...]` (any provider with `snapshot`/`subscribe` — the
memory provider qualifies) and see every entry, its `cachedAt`, and pending
markers.

## Not in scope (by design)

- **A global query client / provider.** Caches are plain objects you create
  and pass; there is no context, no `<QueryClientProvider>`.
- **Query key serialization & partial matching.** Keys are your raw argument
  tuples; "partial matching" is expressed as `deletePrefix` (hashed-key
  prefix) or `deleteWhere` (args predicate) instead of a fuzzy key matcher.
- **Declarative `enabled`/`select`/`placeholderData` per call site.** These
  are composed with regular React (conditional hooks, `useResultSelect`,
  `keepPreviousData`) rather than configured on one hook.
- **Persistence adapters, offline mutation queue, request deduplication
  across tabs.** The provider is in-memory; bring your own storage-backed
  `CacheProvider` (the interface is five required members + opt-ins).
- **Retry token buckets / circuit breakers.** `useRetry` covers bounded
  exponential backoff only.
