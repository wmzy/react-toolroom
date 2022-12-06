import {
  View,
  MemoryRouter,
  HashRouter,
  Router,
  Route
} from 'native-router-react';
import Loading from '@/components/Loading';
import RouterError from '@/components/RouterError';

export default function App() {
  const mode = window.location.search.slice(1);
  const routes = {
    component: () => import('./Layout'),
    children: [
      {
        path: '/',
        component: () => import('./Home')
      },
      {
        path: '/async',
        component: () => import('./Async')
      },
      {
        path: '/help',
        component: () => import('./Help')
      },
      {
        path: '/about',
        component: () => import('./About')
      }
    ]
  } as Route;

  if (mode === 'hash') {
    return (
      <HashRouter
        routes={routes}
        // eslint-disable-next-line react/no-unstable-nested-components
        errorHandler={(e) => <RouterError error={e} />}
      >
        <View />
        <Loading />
      </HashRouter>
    );
  }

  if (mode === 'memory') {
    return (
      <MemoryRouter
        initialEntries={['/']}
        routes={routes}
        errorHandler={(e) => <RouterError error={e} />}
      >
        <View />
        <Loading />
      </MemoryRouter>
    );
  }

  return (
    <Router
      routes={routes}
      // baseUrl={import.meta.env.BASE_URL.slice(0, -1)}
      baseUrl={process.env.BASE_URL?.slice(0, -1)}
      errorHandler={(e) => <RouterError error={e} />}
    >
      <View />
      <Loading />
    </Router>
  );
}
