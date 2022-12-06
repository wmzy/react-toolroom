
export type Func = (...args: any[]) => any;
export type AsyncFunc = (...args: any[]) => Promise<any>;
export type Awaited<T> = T extends Promise<infer A> ? A : T;
export type R<AF extends AsyncFunc> = Awaited<ReturnType<AF>>;
// export type Void<F extends AsyncFunc> = F extends (...args: infer P) => Promise<any> ? (...args: P) => Promise<void> : never;
export type Void<AF extends AsyncFunc> = (...args: Parameters<AF>) => Promise<void>;
