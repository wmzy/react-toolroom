import {
  type ComponentProps,
  type ComponentType,
  type FunctionComponent,
  type MemoExoticComponent,
  type NamedExoticComponent,
  forwardRef,
  memo as reactMemo,
  useRef
} from 'react';
import {getDisplayName} from './util';

type DefaultTestEvent = (k: string) => boolean;
type PropsAreEqual<P> = (
  prevProps: Readonly<P>,
  nextProps: Readonly<P>
) => boolean;

type MemoOptions<P> = {
  testEvent: DefaultTestEvent;
  propsAreEqual?: PropsAreEqual<P>;
};

export function defaultTestEvent(k: string) {
  return /^on[A-Z]/.test(k);
}

export function memoBase<P extends object>(
  Component: FunctionComponent<P>,
  options: MemoOptions<P>
): NamedExoticComponent<P>;
export function memoBase<T extends ComponentType<any>>(
  Component: T,
  options: MemoOptions<ComponentProps<T>>
): MemoExoticComponent<T>;
export function memoBase<P extends object>(
  WrappedComponent: ComponentType<P>,
  {testEvent, propsAreEqual}: MemoOptions<P>
) {
  const MemoComponent = reactMemo(WrappedComponent, propsAreEqual);

  const FixedComponent = forwardRef((props: P, ref) => {
    const memoEventsRef = useRef<Record<string, any>>({});
    const memoEvents = memoEventsRef.current;
    const newMemoEvents = Object.keys(props)
      .filter(testEvent)
      .reduce((me, k) => {
        const handler = props[k as keyof P];
        if (typeof handler !== 'function') {
          return me;
        }
        return {...me, [k]: fixEventHandler(memoEvents[k], handler)};
      }, {} as Record<string, any>);

    memoEventsRef.current = newMemoEvents;

    // @ts-expect-error
    return <MemoComponent ref={ref} {...props} {...newMemoEvents} />;
  });

  FixedComponent.displayName = `FixedEvents(${getDisplayName(MemoComponent)})`;

  return FixedComponent;
}

export default function memo<P extends object>(
  Component: FunctionComponent<P>,
  options?: MemoOptions<P> | PropsAreEqual<P>
): NamedExoticComponent<P>;
export default function memo<T extends ComponentType<any>>(
  Component: T,
  options?: MemoOptions<ComponentProps<T>> | PropsAreEqual<ComponentProps<T>>
): MemoExoticComponent<T>;
export default function memo<P extends object>(
  Component: ComponentType<P>,
  options?: Partial<MemoOptions<P>> | PropsAreEqual<P>
) {
  if (!options) return memoBase(Component, {testEvent: defaultTestEvent});
  if (typeof options === 'function') {
    return memoBase(Component, {
      testEvent: defaultTestEvent,
      propsAreEqual: options
    });
  }
  return memoBase(Component, {testEvent: defaultTestEvent, ...options});
}

const wm = new WeakMap<Function, Function>();

function fixEventHandler<F extends (...args: any) => any>(
  fixed: F | undefined,
  handler: F
) {
  if (wm.has(handler)) return handler;
  if (!fixed) {
    fixed = ((...params: any) => {
      const h = wm.get(fixed!)!;
      return h(...params);
    }) as F;
  }

  wm.set(fixed!, handler);
  return fixed;
}
