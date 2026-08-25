import {describe, it, expect, vi} from 'vitest';
import {render, screen, fireEvent} from '@testing-library/react';
import React, {forwardRef, useState} from 'react';
import {defaultTestEvent, memoBase} from '../src/memo';
import memo from '../src/memo';

describe('memo', () => {
  describe('defaultTestEvent', () => {
    it('should return true for onClick', () => {
      expect(defaultTestEvent('onClick')).toBe(true);
    });

    it('should return true for onChange', () => {
      expect(defaultTestEvent('onChange')).toBe(true);
    });

    it('should return true for onMouseEnter', () => {
      expect(defaultTestEvent('onMouseEnter')).toBe(true);
    });

    it('should return true for onFocus', () => {
      expect(defaultTestEvent('onFocus')).toBe(true);
    });

    it('should return true for onBlur', () => {
      expect(defaultTestEvent('onBlur')).toBe(true);
    });

    it('should return false for className', () => {
      expect(defaultTestEvent('className')).toBe(false);
    });

    it('should return false for value', () => {
      expect(defaultTestEvent('value')).toBe(false);
    });

    it('should return false for children', () => {
      expect(defaultTestEvent('children')).toBe(false);
    });

    it('should return false for id', () => {
      expect(defaultTestEvent('id')).toBe(false);
    });

    it('should return false for style', () => {
      expect(defaultTestEvent('style')).toBe(false);
    });
  });

  describe('memoBase', () => {
    it('should Render component with options', () => {
      const Component = ({name}: {name: string}) => <div>{name}</div>;
      const MemoComponent = memoBase(Component, {testEvent: defaultTestEvent});

      render(<MemoComponent name='test' />);

      expect(screen.getByText('test')).toBeDefined();
    });

    it('should forward ref', () => {
      const Component = (
        {name}: {name: string},
        ref: React.Ref<HTMLDivElement>
      ) => <div ref={ref}>{name}</div>;
      const MemoComponent = memoBase(React.memo(forwardRef(Component)), {
        testEvent: defaultTestEvent
      });
      const ref = {current: null};

      render(<MemoComponent name='test' ref={ref} />);

      expect(ref.current).toBeDefined();
    });

    it('should use custom testEvent', () => {
      const testEvent = (k: string) => k.startsWith('data-');
      const Component = ({
        dataId,
        onClick
      }: {
        dataId: string;
        onClick: () => void;
      }) => (
        <div data-testid={dataId} onClick={onClick}>
          test
        </div>
      );
      const MemoComponent = memoBase(Component, {testEvent});

      const onClick = vi.fn();
      render(<MemoComponent dataId='123' onClick={onClick} />);

      fireEvent.click(screen.getByTestId('123'));
      expect(onClick).toHaveBeenCalled();
    });

    it('should memoize event handlers', async () => {
      const Component = ({onClick}: {onClick: () => void}) => (
        <button onClick={onClick}>click</button>
      );
      const MemoComponent = memoBase(Component, {testEvent: defaultTestEvent});

      const onClick = vi.fn();
      const {rerender} = render(<MemoComponent onClick={onClick} />);

      fireEvent.click(screen.getByRole('button'));
      expect(onClick).toHaveBeenCalledTimes(1);

      rerender(<MemoComponent onClick={onClick} />);
      fireEvent.click(screen.getByRole('button'));
      expect(onClick).toHaveBeenCalledTimes(2);
    });

    it('should handle event handlers with custom testEvent', () => {
      const testEvent = (k: string) => k.startsWith('on');
      const onClick = vi.fn();
      const onFocus = vi.fn();

      const Component = ({
        onClick,
        onFocus
      }: {
        onClick: () => void;
        onFocus: () => void;
      }) => (
        <div>
          <button onClick={onClick} onFocus={onFocus}>
            click
          </button>
        </div>
      );
      const MemoComponent = memoBase(Component, {testEvent});

      render(<MemoComponent onClick={onClick} onFocus={onFocus} />);

      fireEvent.click(screen.getByRole('button'));
      expect(onClick).toHaveBeenCalled();
    });

    it('should not memoize non-function props', () => {
      const Component = ({
        name,
        onClick
      }: {
        name: string;
        onClick: () => void;
      }) => (
        <div>
          <span>{name}</span>
          <button onClick={onClick}>click</button>
        </div>
      );
      const MemoComponent = memoBase(Component, {testEvent: defaultTestEvent});

      const onClick = vi.fn();
      const {rerender} = render(
        <MemoComponent name='first' onClick={onClick} />
      );

      rerender(<MemoComponent name='second' onClick={onClick} />);

      expect(screen.getByText('second')).toBeDefined();
    });

    it('should handle non-function handlers', () => {
      const Component = ({
        name,
        data,
        onClick
      }: {
        name: string;
        data: string;
        onClick?: () => void;
      }) => (
        <div data-testid='data-value' data-value={data}>
          <span>{name}</span>
          <button onClick={onClick}>click</button>
        </div>
      );
      const MemoComponent = memoBase(Component, {testEvent: defaultTestEvent});

      // Pass non-function values for event handlers
      const props = {
        name: 'test',
        data: 'value',
        onClick: undefined,
        onChange: null,
        disabled: true
      };

      render(<MemoComponent {...props} />);

      expect(screen.getByText('test')).toBeDefined();
      expect(screen.getByTestId('data-value')).toBeDefined();
    });

    it('should reuse an already-fixed handler arriving from another memo', () => {
      const handler = vi.fn();
      const childProps: (() => void)[] = [];
      const ChildInner = ({onChange}: {onChange: () => void}) => {
        childProps.push(onChange);
        return <button onClick={onChange}>child</button>;
      };
      const ChildMemo = memoBase(ChildInner, {
        testEvent: (k) => k === 'onChange'
      });
      const ParentInner = ({onChange}: {onChange: () => void}) => (
        <ChildMemo onChange={onChange} />
      );
      const ParentMemo = memoBase(ParentInner, {
        testEvent: (k) => k === 'onChange'
      });

      const {rerender} = render(<ParentMemo onChange={handler} />);
      // rerender with the same handler: memo bails out, the child renders
      // nothing new — but the click path below still dispatches once
      rerender(<ParentMemo onChange={handler} />);

      // The parent already fixed the handler, and the child re-fixes the
      // FIXED handler into its own stable wrapper — the chain stays
      // indirection-only, so a single click still dispatches exactly once.
      fireEvent.click(screen.getByText('child'));
      expect(handler).toHaveBeenCalledTimes(1); // exactly one invocation
    });
  });

  describe('default memo export', () => {
    it('should work without options (line 82)', () => {
      const Component = ({name}: {name: string}) => <div>{name}</div>;
      const MemoComponent = memo(Component);

      render(<MemoComponent name='test no options' />);

      expect(screen.getByText('test no options')).toBeDefined();
    });

    it('should work with function options (propsAreEqual) (lines 83-87)', () => {
      const Component = ({name, count}: {name: string; count: number}) => (
        <div data-testid='comp'>
          {name} - {count}
        </div>
      );

      const propsAreEqual = (
        prev: {name: string; count: number},
        next: {name: string; count: number}
      ) => {
        return prev.name === next.name;
      };

      const MemoComponent = memo(Component, propsAreEqual);

      const {rerender} = render(<MemoComponent name='test' count={1} />);
      expect(screen.getByTestId('comp').textContent).toBe('test - 1');

      rerender(<MemoComponent name='test' count={2} />);
      expect(screen.getByTestId('comp').textContent).toBe('test - 1');

      rerender(<MemoComponent name='changed' count={2} />);
      expect(screen.getByTestId('comp').textContent).toBe('changed - 2');
    });

    it('should work with object options (line 89)', () => {
      const customTestEvent = (k: string) => k.startsWith('handle');

      const Component = ({
        handleClick,
        name
      }: {
        handleClick: () => void;
        name: string;
      }) => <button onClick={handleClick}>{name}</button>;

      const MemoComponent = memo(Component, {testEvent: customTestEvent});

      const handleClick = vi.fn();
      render(<MemoComponent handleClick={handleClick} name='click me' />);

      fireEvent.click(screen.getByRole('button'));
      expect(handleClick).toHaveBeenCalled();
    });

    it('should work with object options including propsAreEqual', () => {
      const Component = ({value}: {value: number}) => (
        <div data-testid='value'>{value}</div>
      );

      const propsAreEqual = (prev: {value: number}, next: {value: number}) => {
        return prev.value === next.value;
      };

      const MemoComponent = memo(Component, {
        testEvent: defaultTestEvent,
        propsAreEqual
      });

      const {rerender} = render(<MemoComponent value={1} />);
      expect(screen.getByTestId('value').textContent).toBe('1');

      rerender(<MemoComponent value={1} />);
      expect(screen.getByTestId('value').textContent).toBe('1');
    });
  });
});
