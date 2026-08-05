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
      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-bg-elevated text-muted">
        <FiMic className="w-3.5 h-3.5" />
        {enabled ? 'Captions active' : 'Captions off'}
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
      title={enabled ? 'Disable captions & games' : 'Enable captions & games'}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait ${
        enabled
          ? 'bg-primary/20 text-primary hover:bg-primary/30'
          : 'bg-bg-elevated text-muted hover:bg-border'
      }`}
    >
      {busy ? (
        <FiLoader className="w-3.5 h-3.5 animate-spin" />
      ) : enabled ? (
        <FiMic className="w-3.5 h-3.5" />
      ) : (
        <FiMicOff className="w-3.5 h-3.5" />
      )}
      {enabled ? 'Captions active' : 'Enable captions & games'}
    </button>
  );
}
