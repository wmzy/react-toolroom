# React Toolroom

> A lightweight toolset for React developers.

[中文](./README-zh_CN.md) | English

## Why React Toolroom?

- **Memo optimization** - Automatic event handler memoization
- **Async data fetching** - Simple hooks for API calls
- **Zero dependencies** - Tiny bundle size
- **TypeScript first** - Full type safety

## Install

```bash
npm i react-toolroom
```

## Modules

### Core Module

```tsx
import { memo } from 'react-toolroom';

// Automatically memoizes event handlers
const Button = memo(({ onClick, children }) => {
  return <button onClick={onClick}>{children}</button>;
});
```

### Async Module

```tsx
import { 
  useResult, 
  useLoading, 
  useRun, 
  useInjectable, 
  useError,
  useCache 
} from 'react-toolroom/async';

// Create a data fetcher
const fetchUsers = useInjectable(async () => {
  const res = await fetch('/api/users');
  return res.json();
});

// Use in component
function UserList() {
  const users = useResult(fetchUsers);
  const loading = useLoading(fetchUsers);
  const error = useError(fetchUsers);
  
  useRun(fetchUsers, []);
  
  if (loading) return <Spinner />;
  if (error) return <Error error={error} />;
  
  return <ul>{users.map(u => <li>{u.name}</li>)}</ul>;
}

// With caching
function CachedUserList() {
  const stale = useCache(fetchUsers, cacheProvider, 60000);
  // ...
}
```

## API

### memo

An enhanced version of React.memo that automatically memoizes event handlers.

```tsx
memo(Component, { testEvent, propsAreEqual })
```

| Option | Type | Description |
|--------|------|-------------|
| testEvent | (key: string) => boolean | Test if prop is event handler (default: /^on[A-Z]/) |
| propsAreEqual | (prev, next) => boolean | Custom comparison |

### useInjectable

Wraps an async function for use with other hooks.

### useResult

Gets the result of an async function.

### useLoading

Gets the loading state of an async function.

### useError

Gets the error of a failed async function.

### useRun

Runs a function when dependencies change.

### useCache

Caches async function results with stale-while-revalidate.

### useCatch

Catches errors from async function.

### useFinally

Adds a handler that runs after async function completes.

## Demos

Check [demos](./demos/) for a complete example.

## Documentation 

[Documentation](https://wmzy.github.io/react-toolroom/)

## Related Projects

- [painless](https://github.com/wmzy/painless) - Frontend template
- [native-router](https://github.com/native-router/react) - Routing

## Contributing

Contributions are always welcome!

## License

MIT
