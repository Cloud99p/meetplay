import { useState } from 'react';
import { FiMic, FiMicOff, FiLoader } from 'react-icons/fi';

interface Props {
  isHost: boolean;
  enabled: boolean;
  onToggle: (enabled: boolean) => Promise<void> | void;
}

/**
 * Host-only control: enables captions & games (transcription).
 * Non-hosts see a read-only badge instead of the toggle.
 */
export default function TranscriptToggle({ isHost, enabled, onToggle }: Props) {
  const [busy, setBusy] = useState(false);

  if (!isHost) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${
          enabled ? 'bg-primary/10 text-primary' : 'bg-bg-elevated text-muted'
        }`}
        title={enabled ? 'Captions are on' : 'Captions are off'}
      >
        {enabled ? <FiMic className="w-3.5 h-3.5" /> : <FiMicOff className="w-3.5 h-3.5" />}
        {enabled ? 'Captions on' : 'Captions off'}
      </span>
    );
  }

  const handleToggle = async () => {
    setBusy(true);
    try {
      await onToggle(!enabled);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleToggle}
      disabled={busy}
      title={
        enabled
          ? 'Captions & games are ON — tap to turn off'
          : 'Captions & games are OFF — tap to enable (powers word bets, bingo, quizzes)'
      }
      className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-full text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait border ${
        enabled
          ? 'bg-primary/15 text-primary border-primary/40 hover:bg-primary/25'
          : 'bg-amber-500/10 text-amber-500 border-amber-500/40 hover:bg-amber-500/20'
      }`}
    >
      {busy ? (
        <FiLoader className="w-4 h-4 animate-spin" />
      ) : enabled ? (
        <FiMic className="w-4 h-4" />
      ) : (
        <FiMicOff className="w-4 h-4" />
      )}
      {enabled ? 'Captions & games ON' : 'Enable captions & games'}
    </button>
  );
}
