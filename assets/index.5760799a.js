import { r as react, j as jsxs, a as jsx } from './index.80a5a7ef.js';

function thru(interceptor) {
  return v => (interceptor(v), v);
}
function thruSet(set) {
  return v => (set(() => v), v);
}
function thruError(set) {
  return e => {
    set(e);
    throw e;
  };
}

const map = new WeakMap();
function useInjectable(fn) {
  const ref = react.exports.useRef();
  ref.current = [fn, []];
  const f = react.exports.useCallback((...args) => {
    const [func, injects] = ref.current;
    return injects.reduce((i, w) => w(i), func)(...args);
  }, []);
  map.set(f, ref);
  return f;
}
function useInject(fn, wrapper) {
  const ref = map.get(fn);
  ref.current[1].push(wrapper);
}

function useLoading$1() {
  const [count, setCount] = react.exports.useState(0);
  const withLoading = p => (setCount(c => c + 1), p.finally(() => setCount(c => c - 1)));
  return [Boolean(count), withLoading];
}
function useLoadingFn() {
  const [loading, withLoading] = useLoading$1();
  const wrap = fn => (...args) => withLoading(fn(...args));
  return [loading, wrap];
}

function useResult(injectableFn, init) {
  const [result, setResult] = react.exports.useState(init);
  useInject(injectableFn, f => (...args) => f(...args).then(thruSet(setResult)));
  return result;
}
function useError(injectableFn) {
  const [error, setError] = react.exports.useState();
  useInject(injectableFn, f => (...args) => f(...args).then(thru(() => setError(undefined))).catch(thruError(setError)));
  return error;
}
function useLoading(injectableFn) {
  const [loading, withLoading] = useLoadingFn();
  useInject(injectableFn, withLoading);
  return loading;
}
function useRun(fn, args) {
  react.exports.useEffect(() => void fn(...args), args);
}

/* eslint-disable import/prefer-default-export */
function sleep(interval) {
  return new Promise(resolve => {
    setTimeout(resolve, interval);
  });
}

function genUser(id) {
  return {
    id,
    username: `user ${id}`,
    description: '...',
    updatedAt: Date.now()
  };
}
function* genId(size) {
  let i = 1;
  while (i < size) {
    yield i++;
  }
  return i;
}
async function fetchList(size) {
  console.log('fetch list start');
  await sleep(1000);
  if (size && size < 0) {
    console.log('fetch list fail');
    throw new Error('PARAMS ERROR: [size] could not lower than 0');
  }
  console.log('fetch list done');
  return Array.from(genId(10)).map(genUser);
}

const index_1r00m6o = '';

function Async() {
  const fetchUserList = useInjectable(fetchList);
  const users = useResult(fetchUserList);
  const loading = useLoading(fetchUserList);
  const error = useError(fetchUserList);
  useRun(fetchUserList, []);
  if (loading) return 'loading...';
  if (error) {
    return /*#__PURE__*/jsxs("div", {
      children: [/*#__PURE__*/jsx("h1", {
        children: error.message
      }), /*#__PURE__*/jsx("pre", {
        children: error.stack
      }), /*#__PURE__*/jsx("button", {
        type: "button",
        onClick: () => fetchUserList(),
        children: "refresh"
      })]
    });
  }
  return /*#__PURE__*/jsxs("div", {
    children: [/*#__PURE__*/jsx("h1", {
      className: "hpy0lx",
      children: "User List"
    }), /*#__PURE__*/jsxs("div", {
      children: [/*#__PURE__*/jsx("button", {
        type: "button",
        onClick: () => fetchUserList(),
        children: "refresh"
      }), /*#__PURE__*/jsx("button", {
        type: "button",
        onClick: () => fetchUserList(-1),
        children: "refresh(Error)"
      })]
    }), /*#__PURE__*/jsx("ul", {
      children: users?.map(user => /*#__PURE__*/jsx("li", {
        children: user.username
      }, user.id))
    })]
  });
}

export { Async as default };
