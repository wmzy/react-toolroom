# No structural sharing: the memo strategy

Every settle produces a new reference. That is a design decision, not an
oversight — this page explains the tradeoff, what it costs you, and how to
keep re-renders cheap without reintroducing the cost the design refused to
pay.

## The behavior

When a fetch settles — a first load, a background revalidation, an
invalidation refetch — the result store and the cache are written with the
freshly deserialized value. Nothing walks the payload comparing it node by
node against the previous value to rebuild a "maximally shared" tree
(TanStack Query's `replaceEqualDeep`, what its docs call *structural
sharing*). Consequences:

- A content-identical background revalidation re-renders every subscriber
  of that result: the new value is a new reference even though every field
  is equal.
- Objects *inside* a settled result are new references too — a list row's
  entity object, a nested `author` object, all fresh on every settle.
- React.memo boundaries that receive object props therefore never skip on
  the settle path. Shallow comparison sees a new reference and re-renders.

## Why: O(payload) on every fetch vs a cheap reconcile

Structural sharing exists to keep references stable so that memo
boundaries keyed on object props keep skipping. To do that, it must
deep-walk the old and the new payload on **every settle** — every fetch,
every poll tick, every refetch on focus — comparing node by node and
allocating a merged tree along the way. The cost scales with the payload,
sits on the hot path of data fetching, and is paid even when nothing
changed (which is exactly the case it exists to detect).

react-toolroom keeps the settle path dumb: write the new reference,
compare identities. The "don't re-render" decision moves to places where
it is cheap and local — and where *you* know what actually changed:

| Instead of | Do this | Why it is cheap |
| --- | --- | --- |
| Deep-comparing payloads at settle time | Scalar props behind `React.memo` | Settles produce equal primitives — shallow comparison skips on value equality |
| `useCallback` on every event prop handed to a memo boundary | The core `memo` — `on*` props are stabilized automatically | The boundary sees one stable forwarder identity; calls dispatch to the latest closure |
| Structural sharing so `select`-ed slices keep skipping | `useResultSelect` with a **primitive** projection | The projection is cached against the result reference; a content-identical settle keeps the primitive `Object.is`-equal, so that subscriber does not re-render |
| Guessing what changed by diffing old vs new | Reference-preserving writes on the mutation side | A mutation knows exactly which entry it touched — patch that entry, leave every other reference alone |

`useResultSelect` is the partial equivalent of structural sharing and
worth understanding precisely: its `select` output is memoized against the
exact result reference it was computed from, so an unrelated re-render
neither re-runs `select` nor changes the projected reference. When the
result settles (new reference), the projection recomputes — if it returns
a primitive (`r.total`, `r.article.favorited`), a content-identical
settle still produces an equal snapshot and the subscriber skips the
re-render. If it returns a **fresh object**, the new reference propagates
and the subscriber re-renders — same rule as everywhere else in this
design: keep projections primitive.

## The counter-example: a memo boundary on object props

```tsx
// Decorative memo: every settle produces a new `article` reference,
// the shallow compare always fails, the card always re-renders.
const Card = React.memo(function Card({article, onFavorite}: CardProps) {
  /* ... */
});
```

Wrapping a component in `React.memo` while handing it the settled object
accomplishes nothing on the settle path — the object prop is a new
reference every time, so the boundary re-renders unconditionally. The
memo only starts paying once *something else* stabilizes the props:
scalar values, or object references your own write path preserves (below).

And the tempting "fix" is worse than the problem:

```tsx
// Hand-rolled structural sharing — at the wrong layer.
const Card = React.memo(CardImpl, (prev, next) =>
  deepEqual(prev.article, next.article)
);
```

A custom `propsAreEqual` that compares the object deeply runs on **every
parent render** (more often than per settle), with no caching, and you
have rebuilt the O(payload) deep-compare the library deliberately left
out — plus the allocation churn of whatever `deepEqual` does. If you
reach for a deep comparator, what you actually want is either scalar
props at that boundary, or a write-side patch that preserves references.

## Case study: painless `ArticlePreview`

The [painless](https://github.com/wmzy/painless) template's home feed is
the pattern in production shape. Each card is:

```tsx
import {memo} from 'react-toolroom';

type Props = {
  article: Article;
  // The on* prefix matters — see below.
  onFavorite: (slug: string, on: boolean) => void;
};

function ArticlePreview({article, onFavorite}: Props) {
  /* avatar row, favorite button, title link, description, tags */
}

export default memo(ArticlePreview);
```

Three decisions make the boundary real:

1. **`memo` from the core entry, not `React.memo`.** Home builds
   `onFavorite` as a fresh closure on every render — through the core
   `memo`'s stable `on*` forwarder, the boundary sees one identity for
   the hook's lifetime while calls dispatch to the latest closure. No
   `useCallback`, and parent re-renders alone never break the boundary.
2. **The write path preserves references.** A favorite click runs a
   `cache.mutation` pipeline over the home feed's cache projection: the
   patch replaces only the target article (`{...x, ...patch}` for the
   matching slug) and returns every other array item **unchanged — same
   reference**. The settle fans out as a refresh; untouched cards'
   `article` props are reference-equal, so the whole-page re-render cost
   converges to exactly the one card that changed. This is reference
   preservation where it belongs: the mutation knows what it touched;
   a read-side differ could only guess.
3. **The settle path is accepted as-is.** A background revalidation of
   the feed settles a new array of new references — every card
   re-renders once. That is the deliberate cost of not deep-walking
   payloads on every fetch, paid where it is cheap: a list that just
   received data renders it anyway.

The same card could go one step further and take scalar props
(`title`, `description`, `favorited`, `favoritesCount`, …) — then even a
feed settle would skip every card whose fields are equal, which is
precisely what structural sharing would have bought, restricted to one
boundary and with no library-side diffing. The template keeps the entity
object because the card reads many fields and the write-side patch
already covers the hot path (favorites); pick per boundary, not
globally.

## Summary

- Settle = new reference, always. Budget for one re-render of data
  subscribers per settle; that render is showing fresh data anyway.
- Hot boundaries: scalar props, or object props whose references your
  write path preserves. Event props: the core `memo`'s `on*`
  stabilization.
- Slice-level skip: `useResultSelect` with primitive projections.
- Never a deep `propsAreEqual` — that is structural sharing rebuilt by
  hand, on the wrong path.
