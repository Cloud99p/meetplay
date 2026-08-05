import { useState } from 'react';
import { FiVideo, FiArrowRight } from 'react-icons/fi';
import * as api from '../../lib/api';
import CreateRoom from './CreateRoom';
import JoinRoom from './JoinRoom';

interface Props {
  onCreate: (name?: string, password?: string) => Promise<string>;
  state: { room: { id: string } | null; connected: boolean };
}

type LobbyView = 'create' | 'join';

export default function Lobby({ onCreate }: Props) {
  const [view, setView] = useState<LobbyView>('create');

  return (
    <div className="min-h-screen bg-bg-base flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/20 mx-auto mb-4">
            <FiVideo className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-heading font-bold text-foreground">MeetPlay</h1>
          <p className="text-sm text-muted mt-1">Video meetings that keep you engaged</p>
        </div>

        {/* View switcher */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setView('create')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer ${view === 'create' ? 'bg-primary/15 text-primary' : 'bg-bg-surface text-muted hover:bg-bg-elevated'}`}
          >
            Create Room
          </button>
          <button
            onClick={() => setView('join')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer ${view === 'join' ? 'bg-primary/15 text-primary' : 'bg-bg-surface text-muted hover:bg-bg-elevated'}`}
          >
            Join Room
          </button>
        </div>

        {/* Create view */}
        {view === 'create' && (
          <div className="bg-bg-surface border border-border rounded-xl overflow-hidden">
            <CreateRoom onCreate={onCreate} />
          </div>
        )}

        {/* Join view */}
        {view === 'join' && <JoinRoomLookup />}

        {/* Footer */}
        <p className="text-[10px] text-muted/60 text-center mt-6">
          Runs entirely on your machine. No data leaves your network.
        </p>
      </div>
    </div>
  );
}

function JoinRoomLookup() {
  const [roomId, setRoomId] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [error, setError] = useState('');

  const handleLookup = async () => {
    const id = roomId.trim();
    if (!id) return;
    setError('');
    try {
      const { room } = await api.getRoom(id);
      setHasPassword(room.hasPassword);
      setShowJoin(true);
    } catch (e: any) {
      setError(e?.message ?? 'Room not found');
    }
  };

  if (showJoin) {
    return (
      <div className="bg-bg-surface border border-border rounded-xl overflow-hidden">
        <JoinRoom
          roomId={roomId}
          hasPassword={hasPassword}
          onJoin={async (id, name, pw) => {
            // Route through the dedicated join flow so the app can navigate
            const params = new URLSearchParams({ name, password: pw || '' });
            window.location.hash = `#/join/${encodeURIComponent(id)}?${params.toString()}`;
          }}
        />
      </div>
    );
  }

  return (
    <div className="bg-bg-surface border border-border rounded-xl p-6 space-y-4">
      <h2 className="text-lg font-heading font-semibold text-foreground flex items-center gap-2">
        <FiArrowRight className="w-5 h-5 text-secondary" />
        Join a Room
      </h2>
      <div>
        <label className="block text-sm font-medium text-muted mb-1.5">Room ID or Link</label>
        <input
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          placeholder="Paste the room link or ID"
          onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
          className="w-full px-3 py-2.5 bg-bg-base border border-border rounded-lg text-foreground placeholder:text-muted/50 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-colors text-sm"
        />
      </div>
      {error && (
        <div className="text-destructive text-sm bg-destructive/10 px-3 py-2 rounded-lg">{error}</div>
      )}
      <button
        onClick={handleLookup}
        disabled={!roomId.trim()}
        className="w-full py-2.5 bg-secondary hover:opacity-90 text-on-primary font-medium rounded-lg transition-opacity disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer text-sm"
      >
        Next
      </button>
    </div>
  );
}