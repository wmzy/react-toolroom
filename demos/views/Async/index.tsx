import {css} from '@linaria/core';
import {
  useResult,
  useLoading,
  useRun,
  useInjectable,
  useError,
  createMemoryCacheProvider,
  useCache
} from 'react-toolroom/async';
import {fetchList} from '@/services/user';

const cache = createMemoryCacheProvider<any, any[]>({
  cacheTime: 10000,
  hash: (k: any[]) => JSON.stringify(k)
});

export default function Async() {
  const fetchUserList = useInjectable(fetchList);
  const isStale = useCache(fetchUserList, cache, 2000);
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
      <h1
        className={css`
          text-align: center;
        `}
      >
        User List
      </h1>
      <div>
        <button type='button' onClick={() => fetchUserList()}>
          refresh
        </button>
        <button type='button' onClick={() => fetchUserList(-1)}>
          refresh(Error)
        </button>
      </div>
      {isStale && <p>data was stale</p>}
      <ul>
        {users?.map((user) => (
          <li key={user.id}>{user.username}</li>
        ))}
      </ul>
    </div>
  );
}
