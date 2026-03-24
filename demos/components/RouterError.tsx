import {Link} from '@native-router/react';

type Props = {
  error: Error;
};

export default function RouterError({error}: Props) {
  return (
    <section>
      <h1>Error</h1>
      <pre>{error.stack}</pre>
      <Link to='/'>home</Link>
    </section>
  );
}
