import {useRef} from 'react';

export default function SendButton({onClick}: {onClick: () => void}) {
  const renderCount = useRef(0);
  return (
    <button type='button' onClick={onClick}>
      Send (render count:{renderCount.current++})
    </button>
  );
}
