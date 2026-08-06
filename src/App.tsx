import { useEffect, useRef, useState } from 'react';
import { HashRouter, Routes, Route, useNavigate, useParams, Navigate } from 'react-router-dom';
import { RoomContext } from '@livekit/components-react';
import { useMeeting } from './hooks/useMeeting';
import Lobby from './components/lobby/Lobby';
import MeetingRoom from './components/meeting/MeetingRoom';
import RecapPage from './components/recap/RecapPage';
import JoinFlow from './components/lobby/JoinFlow';

export default function App() {
  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  );
}

function useParamsRoomId(): string | null {
  const { roomId } = useParams<{ roomId: string }>();
  return roomId ?? null;
}

function AppRoutes() {
  const [state, actions] = useMeeting();
  const navigate = useNavigate();

  // When the meeting ends (host ends), go to recap
  useEffect(() => {
    if (state.room?.state === 'ended' && state.room.id) {
      navigate(`/recap/${state.room.id}`);
    }
  }, [state.room?.state, state.room?.id, navigate]);

  const handleCreate = async (name?: string, password?: string) => {
    const roomId = await actions.createAndJoin(name, password);
    navigate(`/meeting/${roomId}`);
    return roomId;
  };

  const handleJoin = async (roomId: string, name: string, password?: string) => {
    await actions.joinRoom(roomId, name, password);
    navigate(`/meeting/${roomId}`);
  };

  const handleLeave = () => {
    actions.leave();
    navigate('/');
  };

  return (
    <Routes>
      <Route
        path="/"
        element={<Lobby state={state} onCreate={handleCreate} />}
      />
      <Route
        path="/join/:roomId"
        element={<JoinFlow state={state} onJoin={handleJoin} />}
      />
      <Route
        path="/meeting/:roomId"
        element={<MeetingRoute state={state} actions={actions} onLeave={handleLeave} />}
      />
      <Route
        path="/recap/:roomId"
        element={<RecapPageWrapper onBack={() => navigate('/')} />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function MeetingRoute({
  state,
  actions,
  onLeave,
}: {
  state: ReturnType<typeof useMeeting>[0];
  actions: ReturnType<typeof useMeeting>[1];
  onLeave: () => void;
}) {
  const roomId = useParamsRoomId();
  const [resuming, setResuming] = useState(false);
  const [resumeFailed, setResumeFailed] = useState(false);
  const triedRef = useRef(false);

  // Refresh recovery: if we landed on /meeting/:roomId with no active room in
  // memory (page reload), try to resume from the session snapshot instead of
  // bouncing the user back to the lobby with no way back in.
  useEffect(() => {
    if (state.room || !roomId || triedRef.current) return;
    triedRef.current = true;
    setResuming(true);
    actions
      .resumeSession()
      .then((ok) => {
        if (!ok) setResumeFailed(true);
      })
      .catch(() => setResumeFailed(true))
      .finally(() => setResuming(false));
  }, [state.room, roomId, actions]);

  if (resuming) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center gap-3 bg-bg text-foreground px-6">
        <div className="w-10 h-10 rounded-full border-4 border-border border-t-primary animate-spin" />
        <p className="text-sm text-muted">Rejoining your meeting…</p>
      </div>
    );
  }

  if (resumeFailed || !state.room || state.room.id !== roomId) {
    return <Navigate to="/" replace />;
  }

  return (
    <RoomContext.Provider value={state.liveKitRoom ?? undefined}>
      <MeetingRoom state={state} actions={actions} onLeave={onLeave} />
    </RoomContext.Provider>
  );
}

function RecapPageWrapper({ onBack }: { onBack: () => void }) {
  const { roomId } = useParams<{ roomId: string }>();
  if (!roomId) return <Navigate to="/" replace />;
  return <RecapPage roomId={roomId} onBack={onBack} />;
}