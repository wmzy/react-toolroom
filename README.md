# react-toolroom

> A toolset for react developers.

## Install

```bash
npm i react-toolroom
```

## Usage

```tsx
import { useResult, useLoading, useRun, useInjectable, useError } from 'react-toolroom/async';
import {fetchList} from '@/services/user';

export default function Async() {
  const fetchUserList = useInjectable(fetchList);
  const users = useResult(fetchUserList);
  const loading = useLoading(fetchUserList);
  const error = useError(fetchUserList);

  useRun(fetchUserList, []);

  if (loading) return 'loading...';
  if (error) {
    return (
      <div>
        <h1>{error.message}</h1>
        <pre>{error.stack}</pre>
        <button type='button' onClick={() => fetchUserList()}>
          refresh
        </button>
      </div>
    );
  }

  return (
    <div>
      <h1>User List</h1>
      <div>
        <button type='button' onClick={() => fetchUserList()}>
          Refresh
        </button>
      </div>
      <ul>
        {users?.map((user) => (
          <li key={user.id}>{user.username}</li>
        ))}
      </ul>
    </div>
  );
}

```
See [demos](/demos/) for a complete example.

## Docs 

[API](https://wmzy.github.io/react-toolroom/)
