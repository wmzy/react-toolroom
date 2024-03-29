import {css} from '@linaria/core';
import {Link, View} from 'native-router-react';

export default function Layout() {
  return (
    <section
      className={css`
        display: flex;
        height: 100vh;
        align-items: stretch;

        & > * {
          overflow: auto;
        }
      `}
    >
      <nav
        className={css`
          width: 200px;
          flex: none;
          border-right: 1px dashed;
        `}
      >
        <ul>
          <li>
            <Link to='/'>Home</Link>
          </li>
          <li>
            <Link to='/memo'>Memo</Link>
          </li>
          <li>
            <Link to='/async'>Async</Link>
          </li>
          <li>
            <Link to='/help'>Help</Link>
          </li>
        </ul>
      </nav>
      <main
        className={css`
          flex: auto;
        `}
      >
        <View />
      </main>
    </section>
  );
}

export const globals = css`
  :global() {
    body {
      margin: 0;
    }
  }
`;
