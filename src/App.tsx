import { useEffect } from 'react';
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

  if (!state.room || state.room.id !== roomId) {
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