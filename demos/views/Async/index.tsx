import {css} from '@linaria/core';
import AbortSignalDemo from './AbortSignalDemo';
import Dedup from './Dedup';
import Focus from './Focus';
import Inject from './Inject';
import Polling from './Polling';
import UserList from './UserList';

export default function Async() {
  return (
    <div
      className={css`
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 16px;
      `}
    >
      <UserList />
      <Dedup />
      <Polling />
      <Focus />
      <AbortSignalDemo />
      <Inject />
    </div>
  );
}
