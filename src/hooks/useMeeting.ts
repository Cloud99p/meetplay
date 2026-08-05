import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { Room } from '../types/meeting';
import type { LeaderboardEntry, RoomStateSnapshot } from '../types/games';
import type { ChatMessage } from '../types/chat';
import * as api from '../lib/api';
import { connectToLiveKit } from '../lib/livekit';
import { useWebSocket } from './useWebSocket';

export interface MeetingState {
  room: Room | null;
  participants: Array<{ id: string; name: string; isHost: boolean; isMuted: boolean }>;
  isHost: boolean;
  participantId: string | null;
  participantName: string | null;
  transcriptionEnabled: boolean;
  connected: boolean;
  liveKitRoom: import('livekit-client').Room | null;
  liveKitConnected: boolean;
  livekitError: string | null;
  messages: ChatMessage[];
  leaderboard: LeaderboardEntry[];
  activeRound: RoomStateSnapshot['activeRound'];
  livekitUrl: string;
  captions: Array<{
    speakerId: string;
    speakerName: string | null;
    text: string;
    isFinal: boolean;
    timestamp: number;
  }>;
}

export interface MeetingActions {
  createAndJoin: (name?: string, password?: string) => Promise<string>;
  joinRoom: (roomId: string, name: string, password?: string) => Promise<void>;
  sendChat: (content: string) => void;
  sendEmoji: (emoji: string) => void;
  toggleHand: (raised: boolean) => void;
  toggleTranscription: (enabled: boolean) => void;
  endMeeting: () => void;
  muteParticipant: (targetId: string) => void;
  removeParticipant: (targetId: string) => void;
  lockRoom: () => void;
  leave: () => void;
  sendCaption: (speakerId: string, text: string, isFinal: boolean) => void;
  submitAnswer: (roundId: string, answer: unknown) => void;
}

export function useMeeting(): [MeetingState, MeetingActions] {
  const ws = useWebSocket();
  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<MeetingState['participants']>([]);
  const [isHost, setIsHost] = useState(false);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [participantName, setParticipantName] = useState<string | null>(null);
  const [transcriptionEnabled, setTranscriptionEnabled] = useState(false);
  const [liveKitRoom, setLiveKitRoom] = useState<import('livekit-client').Room | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [activeRound, setActiveRound] = useState<RoomStateSnapshot['activeRound']>(null);
  const [livekitUrl, setLivekitUrl] = useState('ws://localhost:7880');
  const [captions, setCaptions] = useState<MeetingState['captions']>([]);
  const [livekitError, setLivekitError] = useState<string | null>(null);
  const [liveKitConnected, setLiveKitConnected] = useState(false);

  const roomTokenRef = useRef<string | null>(null);
  const roomIdRef = useRef<string | null>(null);

  // Subscribe to WS events
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      ws.on('room:state', (payload: RoomStateSnapshot) => {
        setParticipants(payload.participants);
        setTranscriptionEnabled(payload.transcriptionEnabled);
        setActiveRound(payload.activeRound);
        setLeaderboard(payload.leaderboard);
        if (payload.roomState) {
          setRoom((prev) => prev ? { ...prev, state: payload.roomState } : prev);
        }
      })
    );

    unsubs.push(
      ws.on('participant:joined', (payload: { id: string; name: string }) => {
        setParticipants((prev) => {
          if (prev.some((p) => p.id === payload.id)) return prev;
          return [...prev, { id: payload.id, name: payload.name, isHost: false, isMuted: false }];
        });
      })
    );

    unsubs.push(
      ws.on('participant:left', (payload: { id: string }) => {
        setParticipants((prev) => prev.filter((p) => p.id !== payload.id));
      })
    );

    unsubs.push(
      ws.on('participant:muted', (payload: { targetId: string; isMuted: boolean }) => {
        setParticipants((prev) =>
          prev.map((p) => (p.id === payload.targetId ? { ...p, isMuted: payload.isMuted } : p))
        );
      })
    );

    unsubs.push(
      ws.on('participant:removed', (payload: { targetId: string }) => {
        if (payload.targetId === participantId) {
          // I was removed
          ws.disconnect();
          setRoom(null);
          setParticipants([]);
          setLiveKitRoom(null);
          api.clearRoomToken();
        } else {
          setParticipants((prev) => prev.filter((p) => p.id !== payload.targetId));
        }
      })
    );

    unsubs.push(
      ws.on('host:promoted', (payload: { participantId: string }) => {
        setParticipants((prev) =>
          prev.map((p) => ({
            ...p,
            isHost: p.id === payload.participantId,
          }))
        );
        if (payload.participantId === participantId) {
          setIsHost(true);
        }
      })
    );

    unsubs.push(
      ws.on('transcript:toggled', (payload: { enabled: boolean }) => {
        setTranscriptionEnabled(payload.enabled);
      })
    );

    unsubs.push(
      ws.on('chat:received', (payload: ChatMessage) => {
        setMessages((prev) => [...prev, payload]);
      })
    );

    unsubs.push(
      ws.on('emoji:received', (payload: { participantId: string; participantName?: string; emoji: string }) => {
        const msg: ChatMessage = {
          id: `emoji-${payload.participantId}-${Date.now()}`,
          participantId: payload.participantId,
          participantName: payload.participantName ?? 'Someone',
          content: payload.emoji,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, msg]);
      })
    );

    unsubs.push(
      ws.on('caption:event', (payload: MeetingState['captions'][number]) => {
        setCaptions((prev) => [...prev.slice(-60), payload]);
      })
    );

    unsubs.push(
      ws.on('room:ended', () => {
        setRoom((prev) => prev ? { ...prev, state: 'ended' } : prev);
        ws.disconnect();
        liveKitRoom?.disconnect();
        setLiveKitRoom(null);
        setLiveKitConnected(false);
      })
    );

    unsubs.push(
      ws.on('room:locked', () => {
        setRoom((prev) => prev ? { ...prev, state: 'locked' } : prev);
      })
    );

    unsubs.push(
      ws.on('game:round:open', (payload: { roundId: string; gameType: string; question: unknown; timeLimit: number }) => {
        setActiveRound({
          roundId: payload.roundId,
          gameType: payload.gameType,
          state: 'open',
          roundData: payload.question,
          timeLimit: payload.timeLimit,
          startedAt: new Date().toISOString(),
        });
      })
    );

    unsubs.push(
      ws.on('game:round:locked', () => {
        setActiveRound((prev) => prev ? { ...prev, state: 'locked' } : prev);
      })
    );

    unsubs.push(
      ws.on('game:round:scored', (payload: { roundId: string; results: any[]; leaderboard: LeaderboardEntry[] }) => {
        setLeaderboard(payload.leaderboard);
        setActiveRound((prev) => prev?.roundId === payload.roundId ? { ...prev, state: 'scored' } : prev);
      })
    );

    return () => unsubs.forEach((u) => u());
  }, [ws, participantId, liveKitRoom]);

  const createAndJoin = useCallback(async (name?: string, password?: string): Promise<string> => {
    const result = await api.createRoom(name, password);
    roomTokenRef.current = result.token;
    roomIdRef.current = result.room.id;
    setRoom(result.room as Room);
    setParticipantId(result.participant.id);
    setParticipantName(result.participant.name || 'Host');
    setIsHost(true);
    setLivekitUrl(result.livekitUrl);
    setParticipants([{ id: result.participant.id, name: result.participant.name || 'Host', isHost: true, isMuted: false }]);

    // Connect WebSocket
    ws.connect(result.room.id, result.participant.id, result.token);

    // Connect LiveKit
    if (result.livekitAvailable === false) {
      // Server confirmed LiveKit is unreachable — skip the 8 s timeout
      console.warn('[meeting] LiveKit not available (server-side check), skipping connection.');
      setLivekitError('The media server is not running or unreachable.');
      setLiveKitConnected(false);
    } else {
      const lkToken = await api.getLiveKitToken(
        result.room.id,
        result.participant.id,
        result.participant.name || 'Host',
        result.token
      );
      const { room: lkRoom, error } = await connectToLiveKit(
        result.room.id,
        result.participant.id,
        result.participant.name || 'Host',
        lkToken.token,
        result.livekitUrl
      );
      if (error) {
        console.error('[meeting] LiveKit connect error:', error);
        setLivekitError(error);
        setLiveKitConnected(false);
      } else {
        setLivekitError(null);
        setLiveKitConnected(true);
      }
      setLiveKitRoom(lkRoom);
    }

    return result.room.id;
  }, [ws]);

  const joinRoom = useCallback(async (roomId: string, name: string, password?: string) => {
    const result = await api.joinRoom(roomId, name, password);
    roomTokenRef.current = result.token;
    roomIdRef.current = result.room.id;
    setRoom(result.room as Room);
    setParticipantId(result.participant.id);
    setParticipantName(result.participant.name);
    setIsHost(false);
    setLivekitUrl(result.livekitUrl);
    setParticipants([{ id: result.participant.id, name: result.participant.name, isHost: false, isMuted: false }]);

    // Connect WebSocket
    ws.connect(result.room.id, result.participant.id, result.token);

    // Fetch chat history
    try {
      const history = await api.getChatHistory(roomId);
      setMessages(history.messages);
    } catch {
      // no history available
    }

    // Connect LiveKit
    if (result.livekitAvailable === false) {
      console.warn('[meeting] LiveKit not available (server-side check), skipping connection.');
      setLivekitError('The media server is not running or unreachable.');
      setLiveKitConnected(false);
    } else {
      const lkToken = await api.getLiveKitToken(
        result.room.id,
        result.participant.id,
        result.participant.name,
        result.token
      );
      const { room: lkRoom, error } = await connectToLiveKit(
        result.room.id,
        result.participant.id,
        result.participant.name,
        lkToken.token,
        result.livekitUrl
      );
      if (error) {
        console.error('[meeting] LiveKit connect error:', error);
        setLivekitError(error);
        setLiveKitConnected(false);
      } else {
        setLivekitError(null);
        setLiveKitConnected(true);
      }
      setLiveKitRoom(lkRoom);
    }
  }, [ws]);

  const sendChat = useCallback((content: string) => {
    ws.send('chat:send', { content });
  }, [ws]);

  const sendEmoji = useCallback((emoji: string) => {
    ws.send('emoji:send', { emoji });
  }, [ws]);

  const toggleHand = useCallback((raised: boolean) => {
    ws.send(raised ? 'hand:raise' : 'hand:lower', {});
  }, [ws]);

  const toggleTranscription = useCallback(async (enabled: boolean) => {
    const token = api.getRoomToken();
    if (!token || !room) return;
    try {
      await api.toggleTranscription(room.id, enabled, token);
      // Server broadcasts transcript:toggled which updates state
    } catch (e) {
      console.error('[meeting] toggle transcription error:', e);
    }
  }, [room]);

  const endMeeting = useCallback(() => {
    ws.send('room:end', {});
  }, [ws]);

  const muteParticipant = useCallback((targetId: string) => {
    ws.send('participant:mute', { targetId });
  }, [ws]);

  const removeParticipant = useCallback((targetId: string) => {
    ws.send('participant:remove', { targetId });
  }, [ws]);

  const lockRoom = useCallback(() => {
    ws.send('room:lock', {});
  }, [ws]);

  const leave = useCallback(() => {
    ws.disconnect();
    liveKitRoom?.disconnect();
    setLiveKitRoom(null);
    setLiveKitConnected(false);
    setLivekitError(null);
    setRoom(null);
    setParticipants([]);
    setMessages([]);
    setCaptions([]);
    api.clearRoomToken();
  }, [ws, liveKitRoom]);

  const sendCaption = useCallback((speakerId: string, text: string, isFinal: boolean) => {
    ws.send('caption:event', { speakerId, text, isFinal });
  }, [ws]);

  const submitAnswer = useCallback((roundId: string, answer: unknown) => {
    ws.send('game:submit', { roundId, answer });
  }, [ws]);

  const state: MeetingState = {
    room,
    participants,
    isHost,
    participantId,
    participantName,
    transcriptionEnabled,
    connected: ws.connected,
    liveKitRoom,
    liveKitConnected,
    livekitError,
    messages,
    leaderboard,
    activeRound,
    livekitUrl,
    captions,
  };

  const actions = useMemo<MeetingActions>(
    () => ({
      createAndJoin,
      joinRoom,
      sendChat,
      sendEmoji,
      toggleHand,
      toggleTranscription,
      endMeeting,
      muteParticipant,
      removeParticipant,
      lockRoom,
      leave,
      sendCaption,
      submitAnswer,
    }),
    [
      createAndJoin,
      joinRoom,
      sendChat,
      sendEmoji,
      toggleHand,
      toggleTranscription,
      endMeeting,
      muteParticipant,
      removeParticipant,
      lockRoom,
      leave,
      sendCaption,
      submitAnswer,
    ]
  );

  return [state, actions];
}