import {css} from '@linaria/core';
import {memo} from 'react-toolroom';

import {useState} from 'react';
import SendButton from './SendButton';

const MemoSendButton = memo(SendButton);

export default function Memo() {
  const [messages, setMessages] = useState<string[]>([]);
  const [text, setText] = useState('');

  const sendMessage = (msg: string) => {
    if (msg) setMessages([...messages, msg]);
  };

  const onClick = () => {
    sendMessage(text);
    setText('');
  };

  return (
    <div
      className={css`
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
      `}
    >
      <h1>Memo demo</h1>
      <ul>
        {messages.map((message, i) => (
          <li key={i}>{message}</li>
        ))}
      </ul>
      <textarea value={text} onChange={(e) => setText(e.target.value)} />
      <SendButton onClick={onClick} />
      <label>
        memoized
        <MemoSendButton onClick={onClick} />
      </label>
    </div>
  );
}
