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
import {section} from '@/util/styles';
import {fetchList} from '@/services/user';

const cache = createMemoryCacheProvider<any, any[]>({
  cacheTime: 10000,
  hash: (k: any[]) => JSON.stringify(k)
});

export default function UserList() {
  const fetchUserList = useInjectable(fetchList);
  const isStale = useCache(fetchUserList, cache, 2000);
  const users = useResult(fetchUserList);
  const loading = useLoading(fetchUserList);
  const error = useError(fetchUserList);

  useRun(fetchUserList, []);

  return (
    <section className={section}>
      <h1
        className={css`
          text-align: center;
        `}
      >
        User List
      </h1>
      {loading && <p>loading...</p>}
      {error && (
        <div>
          <h2>{error.message}</h2>
          <pre>{error.stack}</pre>
        </div>
      )}
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
    </section>
  );
}
