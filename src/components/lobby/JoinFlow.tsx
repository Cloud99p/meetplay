import { useState, useEffect } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import * as api from '../../lib/api';
import JoinRoom from './JoinRoom';

interface Props {
  state: { room: { id: string } | null; connected: boolean };
  onJoin: (roomId: string, name: string, password?: string) => Promise<void>;
}

/**
 * Route component that handles the /join/:roomId flow.
 * Looks up room info, checks for password, then renders JoinRoom.
 */
export default function JoinFlow({ state: _state, onJoin }: Props) {
  const { roomId } = useParams<{ roomId: string }>();
  const [loading, setLoading] = useState(true);
  const [hasPassword, setHasPassword] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!roomId) return;
    (async () => {
      try {
        const { room } = await api.getRoom(roomId);
        setHasPassword(room.hasPassword);
      } catch (e: any) {
        setError(e?.message ?? 'Room not found');
      } finally {
        setLoading(false);
      }
    })();
  }, [roomId]);

  if (!roomId) return <Navigate to="/" replace />;

  if (loading) {
    return (
      <div className="min-h-screen bg-bg-base flex items-center justify-center">
        <p className="text-muted text-sm">Looking up room…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-bg-base flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-destructive text-sm">{error}</p>
          <a href="#/" className="text-primary text-sm underline">Back to lobby</a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-base flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-bg-surface border border-border rounded-xl overflow-hidden">
        <JoinRoom
          roomId={roomId}
          hasPassword={hasPassword}
          onJoin={onJoin}
        />
      </div>
    </div>
  );
}