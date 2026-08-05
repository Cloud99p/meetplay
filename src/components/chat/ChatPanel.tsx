import { useState, useRef, useEffect } from 'react';
import { FiSend, FiSmile } from 'react-icons/fi';
import type { ChatMessage } from '../../types/chat';

interface Props {
  messages: ChatMessage[];
  onSend: (content: string) => void;
  participantId: string | null;
}

const EMOJI_QUICK = ['👍', '😂', '🎉', '🤔', '❤️', '👀', '🙌', '🔥'];

export default function ChatPanel({ messages, onSend, participantId }: Props) {
  const [input, setInput] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-medium text-foreground">Chat</h3>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {messages.length === 0 && (
          <p className="text-xs text-muted text-center pt-8">No messages yet. Say something!</p>
        )}
        {messages.map((msg) => {
          const isMe = msg.participantId === participantId;
          return (
            <div key={msg.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${isMe ? 'bg-primary text-on-primary' : 'bg-bg-elevated text-foreground'}`}>
                {!isMe && (
                  <span className="text-[10px] font-medium text-muted block mb-0.5">{msg.participantName}</span>
                )}
                <span className="whitespace-pre-wrap break-words">{msg.content}</span>
              </div>
              <span className="text-[10px] text-muted mt-0.5 px-1">
                {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 flex items-center gap-1 bg-bg-surface rounded-lg border border-border focus-within:border-primary transition-colors px-3">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message…"
              maxLength={2000}
              className="flex-1 py-2 bg-transparent text-sm text-foreground placeholder:text-muted/50 outline-none"
            />
            <button
              onClick={() => setShowEmoji(!showEmoji)}
              className="p-1 rounded hover:bg-bg-elevated text-muted transition-colors cursor-pointer"
              title="Emoji"
            >
              <FiSmile className="w-4 h-4" />
            </button>
          </div>
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="p-2 bg-primary hover:bg-primary-hover text-on-primary rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer active:scale-95"
            title="Send"
          >
            <FiSend className="w-4 h-4" />
          </button>
        </div>

        {showEmoji && (
          <div className="flex gap-1 mt-2 flex-wrap">
            {EMOJI_QUICK.map((emoji) => (
              <button
                key={emoji}
                onClick={() => {
                  setInput((prev) => prev + emoji);
                  setShowEmoji(false);
                }}
                className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-bg-elevated transition-colors cursor-pointer text-lg"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}