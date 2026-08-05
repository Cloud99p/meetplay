import { useState } from 'react';
import { FiPlus, FiCopy, FiCheck } from 'react-icons/fi';

interface Props {
  onCreate: (name?: string, password?: string) => Promise<string>;
}

export default function CreateRoom({ onCreate }: Props) {
  const [roomName, setRoomName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [roomUrl, setRoomUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const handleCreate = async () => {
    setLoading(true);
    try {
      const id = await onCreate(roomName || undefined, password || undefined);
      const url = `${window.location.origin}/#/join/${id}`;
      setRoomUrl(url);
    } catch (e: any) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(roomUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (roomUrl) {
    return (
      <div className="p-6 max-w-md mx-auto text-center space-y-6">
        <div className="flex items-center justify-center w-14 h-14 rounded-full bg-primary/20 mx-auto">
          <FiCheck className="w-6 h-6 text-primary" />
        </div>
        <h2 className="text-xl font-heading font-semibold text-foreground">Room Created!</h2>
        <p className="text-muted text-sm">Share this link with participants:</p>
        <div className="flex items-center gap-2 bg-bg-surface rounded-lg p-3 border border-border">
          <input
            readOnly
            value={roomUrl}
            className="flex-1 bg-transparent text-sm text-foreground outline-none truncate"
          />
          <button
            onClick={copyLink}
            className="flex-shrink-0 p-2 rounded-md hover:bg-bg-elevated transition-colors cursor-pointer"
            aria-label="Copy room link"
          >
            {copied ? <FiCheck className="w-4 h-4 text-success" /> : <FiCopy className="w-4 h-4 text-muted" />}
          </button>
        </div>
        <p className="text-xs text-muted">Waiting for participants to join…</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-md mx-auto space-y-5">
      <div className="flex items-center gap-3 mb-2">
        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/20">
          <FiPlus className="w-5 h-5 text-primary" />
        </div>
        <h2 className="text-lg font-heading font-semibold text-foreground">New Room</h2>
      </div>

      <div>
        <label className="block text-sm font-medium text-muted mb-1.5">Room Name (optional)</label>
        <input
          value={roomName}
          onChange={(e) => setRoomName(e.target.value)}
          placeholder="e.g. Monday Standup"
          maxLength={80}
          className="w-full px-3 py-2.5 bg-bg-surface border border-border rounded-lg text-foreground placeholder:text-muted/50 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-colors text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-muted mb-1.5">Password (optional)</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Leave blank for open room"
          maxLength={60}
          className="w-full px-3 py-2.5 bg-bg-surface border border-border rounded-lg text-foreground placeholder:text-muted/50 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-colors text-sm"
        />
      </div>

      <button
        onClick={handleCreate}
        disabled={loading}
        className="w-full py-2.5 bg-primary hover:bg-primary-hover text-on-primary font-medium rounded-lg transition-colors duration-150 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer text-sm"
      >
        {loading ? 'Creating…' : 'Create Room'}
      </button>
    </div>
  );
}