import { useState } from 'react';
import { FiUserPlus, FiLock } from 'react-icons/fi';

interface Props {
  roomId: string;
  onJoin: (roomId: string, name: string, password?: string) => Promise<void>;
  hasPassword: boolean;
}

export default function JoinRoom({ roomId, onJoin, hasPassword }: Props) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleJoin = async () => {
    if (!name.trim()) {
      setError('Please enter your name');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await onJoin(roomId, name.trim(), password || undefined);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to join room');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-md mx-auto space-y-5">
      <div className="flex items-center gap-3 mb-2">
        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-secondary/20">
          <FiUserPlus className="w-5 h-5 text-secondary" />
        </div>
        <div>
          <h2 className="text-lg font-heading font-semibold text-foreground">Join Room</h2>
          <p className="text-xs text-muted">Room: {roomId.slice(0, 8)}…</p>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-muted mb-1.5">Your Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter your display name"
          maxLength={40}
          autoFocus
          className="w-full px-3 py-2.5 bg-bg-surface border border-border rounded-lg text-foreground placeholder:text-muted/50 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-colors text-sm"
        />
      </div>

      {hasPassword && (
        <div>
          <label className="block text-sm font-medium text-muted mb-1.5 flex items-center gap-1.5">
            <FiLock className="w-3.5 h-3.5" /> Room Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter room password"
            className="w-full px-3 py-2.5 bg-bg-surface border border-border rounded-lg text-foreground placeholder:text-muted/50 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-colors text-sm"
          />
        </div>
      )}

      {error && (
        <div className="text-destructive text-sm bg-destructive/10 px-3 py-2 rounded-lg">{error}</div>
      )}

      <button
        onClick={handleJoin}
        disabled={loading}
        className="w-full py-2.5 bg-secondary hover:opacity-90 text-on-primary font-medium rounded-lg transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer text-sm"
      >
        {loading ? 'Joining…' : 'Join Meeting'}
      </button>
    </div>
  );
}