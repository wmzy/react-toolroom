# Next.js (App Router / RSC) integration

react-toolroom is plain React hooks plus plain functions — no Provider, no
context, no bundler plugin. A Next.js app needs zero configuration to use
it; the only Next-specific work is moving cache state across the
server/client boundary, which is exactly what `dehydrate`/`hydrate` are
for.

## Client components: hooks work as-is

Add `'use client'` and use the hooks exactly like in any React app — there
is no `<Provider>` to mount, no `next.config` entry, nothing to install
beyond the package itself:

```tsx
'use client';

import {createMemoryCacheProvider} from 'react-toolroom';
import {
  useCache,
  useInjectable,
  useResult,
  useRun
} from 'react-toolroom/async';
import {fetchProjects} from '@/services/projects';

// Module scope — every component importing this module shares one cache.
const projectsCache = createMemoryCacheProvider<Project[], any[]>({
  cacheTime: 60000
});

export function Projects() {
  const loadProjects = useInjectable(fetchProjects);
  useCache(loadProjects, projectsCache, 5000);
  useRun(loadProjects, []);
  const projects = useResult(loadProjects);

  return <ul>{projects?.map((p) => <li key={p.id}>{p.name}</li>)}</ul>;
}
```

Pages Router apps work the same way (minus the `'use client'` directive,
which is an App Router concept).

## Server prefetch → client hydration

The pattern below gives the client a warm cache on the very first render:
a Server Component primes the cache during prefetch, serializes it into
the HTML, and the client merges it back before its first render — so the
first `useCache` lookup is a hit and paints without a single client
request.

**The shared cache module** (no `'use client'` — both sides import it):

```ts
// app/projects/cache.ts
import {createMemoryCacheProvider} from 'react-toolroom';
import type {Project} from '@/services/projects';

export const projectsCache = createMemoryCacheProvider<Project[], any[]>({
  cacheTime: 60000
});
```

**The Server Component** primes and embeds:

```tsx
// app/projects/page.tsx
import {fetchProjects} from '@/services/projects';
import {projectsCache} from './cache';
import Projects from './Projects';

export default async function Page() {
  // Prime the cache while rendering on the server.
  projectsCache.set([], await fetchProjects());

  // Flatten the whole map into a JSON-safe object. Escape `<` so a literal
  // `</script>` inside the data cannot terminate the tag early.
  const payload = JSON.stringify(projectsCache.dehydrate()).replace(
    /</g,
    '\\u003c'
  );

  return (
    <>
      {/* Inert to the browser (type="application/json"), readable by id. */}
      <script
        id="rt-cache"
        type="application/json"
        dangerouslySetInnerHTML={{__html: payload}}
      />
      <Projects />
    </>
  );
}
```

**The client component** hydrates before its first render, then reads the
cache:

```tsx
// app/projects/Projects.tsx
'use client';

import {
  useCache,
  useInjectable,
  useResult,
  useRun
} from 'react-toolroom/async';
import {fetchProjects} from '@/services/projects';
import {projectsCache} from './cache';

// Module scope runs once, when this module is first evaluated in the
// browser — before the first render of anything importing it. Server
// Components never evaluate this file, so `document` is safe here.
const embedded = document.getElementById('rt-cache')?.textContent;
if (embedded) {
  projectsCache.hydrate(JSON.parse(embedded));
}

export default function Projects() {
  const loadProjects = useInjectable(fetchProjects);
  useCache(loadProjects, projectsCache, 5000);
  // This mount-time call goes THROUGH the cache wrapper: the hydrated
  // entry is served immediately, and only revalidates in the background
  // if it is older than `staleTime` — the same SWR behavior as any stale
  // hit.
  useRun(loadProjects, []);
  const projects = useResult(loadProjects);

  return <ul>{projects?.map((p) => <li key={p.id}>{p.name}</li>)}</ul>;
}
```

Notes:

- The server's `set([], …)` and the client's `useRun(loadProjects, [])`
  address the same entry — cache keys hash the raw args tuple, so keep the
  tuples identical on both sides (same lesson as
  `useFocusRevalidate` key alignment).
- `hydrate` **merges** and preserves the server timestamps, so the
  client-side staleness math is computed against when the server actually
  fetched the data.
- During client-side navigation the module has already been evaluated, so
  the hydrate block is skipped and the in-memory cache keeps working — no
  special handling needed.
- One cache per script tag; with several prefetched caches, either emit
  one tag each or merge the payloads into a single `{name: payload}` tag
  and hydrate each cache from its field.

Full `dehydrate`/`hydrate` semantics — merge behavior, timestamp survival,
staleness math — are in the **SSR: dehydrate and hydrate** section of the
[README](../README.md#ssr-dehydrate-and-hydrate).

## Where the hooks may run

- **Client components** (`'use client'`): all hooks, unrestricted.
- **Server Components**: no hooks at all — that is React's rule for RSC,
  not a library limitation. The non-hook pieces (`createMemoryCacheProvider`,
  plain fetchers, the cache's `set`/`dehydrate`) are just JavaScript and are
  exactly what the prefetch above uses.

## React version coverage

`react-toolroom` declares `react ^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0`
as its peer range, which spans every React a Next.js app can run:

| Next.js mode | React it runs | In peer range? |
| --- | --- | --- |
| Pages Router (any modern Next.js) | 16.8 – 18 | ✅ |
| App Router (Next 13/14) | React 18 | ✅ |
| App Router (Next 15+) | React 19 | ✅ |

Next.js bundles its own React, so you do not install (or dedupe) anything
extra — the hooks rely only on APIs that have been stable since 16.8
(`useState`/`useEffect`/`useRef`/`useContext`/`useSyncExternalStore` with
a 16/17 fallback).
