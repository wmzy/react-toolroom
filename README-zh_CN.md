[English](./README.md) | 简体中文

# React Toolroom

> 轻量级 React 开发者工具集。

## 为什么选择 React Toolroom?

- **Memo 优化** - 自动记忆化事件处理函数
- **异步数据获取** - 简单的数据获取 Hooks
- **零依赖** - 极小的包体积
- **TypeScript 优先** - 完整的类型安全

## 安装

```bash
npm i react-toolroom
```

## 模块

### 核心模块

```tsx
import { memo } from 'react-toolroom';

// 自动记忆化事件处理函数
const Button = memo(({ onClick, children }) => {
  return <button onClick={onClick}>{children}</button>;
});
```

### 异步模块

```tsx
import { 
  useResult, 
  useLoading, 
  useRun, 
  useInjectable, 
  useError,
  useCache 
} from 'react-toolroom/async';

// 创建数据获取器
const fetchUsers = useInjectable(async () => {
  const res = await fetch('/api/users');
  return res.json();
});

// 在组件中使用
function UserList() {
  const users = useResult(fetchUsers);
  const loading = useLoading(fetchUsers);
  const error = useError(fetchUsers);
  
  useRun(fetchUsers, []);
  
  if (loading) return <Spinner />;
  if (error) return <Error error={error} />;
  
  return <ul>{users.map(u => <li>{u.name}</li>)}</ul>;
}

// 带缓存
function CachedUserList() {
  const stale = useCache(fetchUsers, cacheProvider, 60000);
  // ...
}
```

## API

### memo

增强版的 React.memo，自动记忆化事件处理函数。

```tsx
memo(Component, { testEvent, propsAreEqual })
```

| 参数 | 类型 | 说明 |
|--------|------|------|
| testEvent | (key: string) => boolean | 测试属性是否为事件处理函数（默认: /^on[A-Z]/） |
| propsAreEqual | (prev, next) => boolean | 自定义比较函数 |

### useInjectable

包装异步函数以供其他 hooks 使用。

### useResult

获取异步函数的结果。

### useLoading

获取异步函数的加载状态。

### useError

获取异步函数的错误。

### useRun

当依赖更改时运行函数。

### useCache

缓存异步函数结果，支持 stale-while-revalidate。

### useCatch

捕获异步函数的错误。

### useFinally

添加在异步函数完成后运行的处理器。

## 示例

查看 [demos](./demos/) 获取完整示例。

## 文档

查看 [API 文档](https://wmzy.github.io/react-toolroom/)

## 相关项目

- [painless](https://github.com/wmzy/painless) - 前端模板
- [native-router](https://github.com/native-router/react) - 路由

## 贡献

欢迎贡献！

## 许可证

MIT
