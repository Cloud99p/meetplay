import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { RoomEvent } from 'livekit-client';
import type { Room } from '../types/meeting';
import type { LeaderboardEntry, RoomStateSnapshot } from '../types/games';
import type { ChatMessage } from '../types/chat';
import * as api from '../lib/api';
import { connectToLiveKitWithRetry, reconnectLiveKit } from '../lib/livekit';
import { saveSessionSnapshot, clearSessionSnapshot, getSessionSnapshot } from '../lib/session';
import { useWebSocket } from './useWebSocket';

export interface MeetingState {
  room: Room | null;
  participants: Array<{ id: string; name: string; isHost: boolean; isMuted: boolean; isCameraOff: boolean }>;
  isHost: boolean;
  participantId: string | null;
  participantName: string | null;
  transcriptionEnabled: boolean;
  connected: boolean;
  liveKitRoom: import('livekit-client').Room | null;
  liveKitConnected: boolean;
  liveKitReconnecting: boolean;
  livekitError: string | null;
  messages: ChatMessage[];
  leaderboard: LeaderboardEntry[];
  activeRound: RoomStateSnapshot['activeRound'];
  market: RoomStateSnapshot['market'];
  flash: RoomStateSnapshot['flash'];
  userMarkets: RoomStateSnapshot['userMarkets'];
  userMarketError: string | null;
  bingo: RoomStateSnapshot['bingo'];
  stats: RoomStateSnapshot['stats'];
  livekitUrl: string;
  captions: Array<{
    speakerId: string;
    speakerName: string | null;
    text: string;
    isFinal: boolean;
    timestamp: number;
  }>;
  gameQuiet: boolean;
  recording: boolean;
  recordingResult: { downloadUrl: string | null; filename: string | null } | null;
  recordingError: string | null;
}

export interface MeetingActions {
  createAndJoin: (name?: string, password?: string) => Promise<string>;
  joinRoom: (roomId: string, name: string, password?: string) => Promise<void>;
  resumeSession: () => Promise<boolean>;
  sendChat: (content: string) => void;
  sendEmoji: (emoji: string) => void;
  toggleHand: (raised: boolean) => void;
  toggleTranscription: (enabled: boolean) => void;
  endMeeting: () => void;
  startRecording: () => void;
  stopRecording: () => void;
  muteParticipant: (targetId: string, muted?: boolean) => void;
  setParticipantCamera: (targetId: string, cameraOff: boolean) => void;
  removeParticipant: (targetId: string) => void;
  lockRoom: () => void;
  leave: () => void;
  sendCaption: (speakerId: string, text: string, isFinal: boolean) => void;
  submitAnswer: (roundId: string, answer: unknown) => void;
  placeMarketBet: (guess: number) => void;
  placeFlashBet: (roundId: string, guess: number) => void;
  createUserMarket: (word: string, guess: number, durationSec?: number) => void;
  placeUserMarketBet: (roundId: string, guess: number) => void;
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
  const [market, setMarket] = useState<RoomStateSnapshot['market']>(null);
  const [flash, setFlash] = useState<RoomStateSnapshot['flash']>(null);
  const [userMarkets, setUserMarkets] = useState<RoomStateSnapshot['userMarkets']>([]);
  const [userMarketError, setUserMarketError] = useState<string | null>(null);
  const [bingo, setBingo] = useState<RoomStateSnapshot['bingo']>(null);
  const [stats, setStats] = useState<RoomStateSnapshot['stats']>([]);
  const [livekitUrl, setLivekitUrl] = useState('ws://localhost:7880');
  const [captions, setCaptions] = useState<MeetingState['captions']>([]);
  const [livekitError, setLivekitError] = useState<string | null>(null);
  const [liveKitConnected, setLiveKitConnected] = useState(false);
  const [liveKitReconnecting, setLiveKitReconnecting] = useState(false);
  // Quiet mode: true while ANY participant is screen-sharing (host presenting).
  // Games keep syncing state but suppress attention-drawing notifications.
  const [gameQuiet, setGameQuiet] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingResult, setRecordingResult] = useState<MeetingState['recordingResult']>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);

  const roomTokenRef = useRef<string | null>(null);
  const roomIdRef = useRef<string | null>(null);
  // LiveKit reconnect bookkeeping: holds the last good connection params and
  // tracks whether a reconnect is in flight (so we don't double-reconnect).
  const lkParamsRef = useRef<{ roomName: string; identity: string; participantName: string; token: string; url: string } | null>(null);
  const reconnectInFlightRef = useRef(false);
  const intentionallyLeftRef = useRef(false);

  // Subscribe to WS events
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      ws.on('room:state', (payload: RoomStateSnapshot) => {
        setParticipants(payload.participants);
        setTranscriptionEnabled(payload.transcriptionEnabled);
        setActiveRound(payload.activeRound);
        setLeaderboard(payload.leaderboard);
        setMarket(payload.market);
        setFlash(payload.flash);
        setUserMarkets(payload.userMarkets ?? []);
        setBingo(payload.bingo);
        setStats(payload.stats ?? []);
        setRecording(Boolean(payload.recording));
        if (payload.roomState) {
          setRoom((prev) => prev ? { ...prev, state: payload.roomState } : prev);
        }
      })
    );

    unsubs.push(
      ws.on('participant:joined', (payload: { id: string; name: string }) => {
        setParticipants((prev) => {
          if (prev.some((p) => p.id === payload.id)) return prev;
          return [...prev, { id: payload.id, name: payload.name, isHost: false, isMuted: false, isCameraOff: false }];
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
      ws.on('participant:camera', (payload: { targetId: string; isCameraOff: boolean }) => {
        setParticipants((prev) =>
          prev.map((p) => (p.id === payload.targetId ? { ...p, isCameraOff: payload.isCameraOff } : p))
        );
      })
    );

    unsubs.push(
      ws.on('participant:removed', (payload: { targetId: string }) => {
        if (payload.targetId === participantId) {
          // I was removed by the host — same as leaving: no reconnect,
          // drop LiveKit cleanly so no zombie connection survives.
          intentionallyLeftRef.current = true;
          reconnectInFlightRef.current = false;
          ws.disconnect();
          liveKitRoom?.disconnect();
          setRoom(null);
          setParticipants([]);
          setLiveKitRoom(null);
          setLiveKitConnected(false);
          setLiveKitReconnecting(false);
          setLivekitError(null);
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
        // Meeting is over for EVERYONE (host ended). Kill the LiveKit retry
        // logic BEFORE disconnecting — otherwise the Disconnected event fires
        // and the reconnect path resurrects a zombie connection to a dying
        // room (re-joining + re-publishing media on the landing page).
        intentionallyLeftRef.current = true;
        reconnectInFlightRef.current = false;
        setRoom((prev) => prev ? { ...prev, state: 'ended' } : prev);
        ws.disconnect();
        liveKitRoom?.disconnect();
        setLiveKitRoom(null);
        setLiveKitConnected(false);
        setLiveKitReconnecting(false);
        setLivekitError(null);
      })
    );

    unsubs.push(
      ws.on('recording:started', () => {
        setRecording(true);
        setRecordingResult(null);
        setRecordingError(null);
      })
    );

    unsubs.push(
      ws.on('recording:stopped', (payload: { recording: boolean; downloadUrl: string | null; filename: string | null }) => {
        setRecording(false);
        setRecordingResult({ downloadUrl: payload.downloadUrl, filename: payload.filename });
        setRecordingError(null);
      })
    );

    unsubs.push(
      ws.on('recording:error', (payload: { message: string }) => {
        setRecording(false);
        setRecordingError(payload.message);
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

    // ── Word Count Bet market (always-on) ──
    unsubs.push(
      ws.on('game:market:open', (payload: { roundId: string; targetWord: string; startedAt: string }) => {
        setMarket({
          roundId: payload.roundId,
          targetWord: payload.targetWord,
          startedAt: payload.startedAt,
          liveCount: 0,
          odds: {},
          myBet: null,
          resolved: false,
        });
      })
    );

    unsubs.push(
      ws.on('game:market:update', (payload: { roundId: string; targetWord: string; liveCount: number; odds: Record<string, number> }) => {
        setMarket((prev) =>
          prev && prev.roundId === payload.roundId
            ? { ...prev, liveCount: payload.liveCount, odds: payload.odds }
            : prev
        );
      })
    );

    unsubs.push(
      ws.on('game:market:bet', (payload: { roundId: string; participantId: string; participantName: string; guess: number; lockedOdds: number; liveCount: number }) => {
        setMarket((prev) => {
          if (!prev || prev.roundId !== payload.roundId) return prev;
          // If this is my own bet, remember my locked odds
          const myBet =
            payload.participantId === participantId
              ? { guess: payload.guess, lockedOdds: payload.lockedOdds }
              : prev.myBet;
          return { ...prev, myBet, liveCount: payload.liveCount };
        });
      })
    );

    unsubs.push(
      ws.on('game:market:resolved', (payload: { roundId: string; targetWord: string; actualCount: number; results: any[]; leaderboard: LeaderboardEntry[] }) => {
        setLeaderboard(payload.leaderboard);
        setMarket((prev) =>
          prev && prev.roundId === payload.roundId
            ? { ...prev, resolved: true, actualCount: payload.actualCount, liveCount: payload.actualCount }
            : prev
        );
      })
    );

    // ── Flash WCB (random short windows) ──
    unsubs.push(
      ws.on('game:flash:open', (payload: { roundId: string; targetWord: string; windowMs: number; startedAt: string; endsAt: string }) => {
        setFlash({
          roundId: payload.roundId,
          targetWord: payload.targetWord,
          windowMs: payload.windowMs,
          startedAt: payload.startedAt,
          endsAt: payload.endsAt,
          liveCount: 0,
          odds: {},
          myBet: null,
          resolved: false,
        });
      })
    );

    unsubs.push(
      ws.on('game:flash:update', (payload: { roundId: string; targetWord: string; liveCount: number; odds: Record<string, number>; remainingMs: number }) => {
        setFlash((prev) =>
          prev && prev.roundId === payload.roundId
            ? { ...prev, liveCount: payload.liveCount, odds: payload.odds, endsAt: new Date(Date.now() + payload.remainingMs).toISOString() }
            : prev
        );
      })
    );

    unsubs.push(
      ws.on('game:flash:bet', (payload: { roundId: string; participantId: string; participantName: string; guess: number; lockedOdds: number; liveCount: number }) => {
        setFlash((prev) => {
          if (!prev || prev.roundId !== payload.roundId) return prev;
          const myBet =
            payload.participantId === participantId
              ? { guess: payload.guess, lockedOdds: payload.lockedOdds }
              : prev.myBet;
          return { ...prev, myBet, liveCount: payload.liveCount };
        });
      })
    );

    unsubs.push(
      ws.on('game:flash:resolved', (payload: { roundId: string; targetWord: string; windowMs: number; actualCount: number; results: any[]; leaderboard: LeaderboardEntry[] }) => {
        setLeaderboard(payload.leaderboard);
        setFlash((prev) =>
          prev && prev.roundId === payload.roundId
            ? { ...prev, resolved: true, actualCount: payload.actualCount, liveCount: payload.actualCount }
            : prev
        );
      })
    );

    // ── Member-created word markets (community) ──
    unsubs.push(
      ws.on('game:userMarket:open', (payload: { roundId: string; targetWord: string; createdBy: string; createdByName: string; startedAt: string; durationSec?: number; endsAt?: string }) => {
        setUserMarkets((prev) => {
          if (prev.some((m) => m.targetWord === payload.targetWord)) return prev;
          return [
            ...prev,
            {
              roundId: payload.roundId,
              targetWord: payload.targetWord,
              createdBy: payload.createdBy,
              createdByName: payload.createdByName,
              startedAt: payload.startedAt,
              endsAt: payload.endsAt,
              durationSec: payload.durationSec,
              liveCount: 0,
              odds: {},
              myBet: null,
              resolved: false,
            },
          ];
        });
        setUserMarketError(null);
      })
    );

    unsubs.push(
      ws.on('game:userMarket:update', (payload: { roundId: string; targetWord: string; liveCount: number; odds: Record<string, number>; remainingMs?: number }) => {
        setUserMarkets((prev) =>
          prev.map((m) =>
            m.roundId === payload.roundId
              ? {
                  ...m,
                  liveCount: payload.liveCount,
                  odds: payload.odds,
                  endsAt: payload.remainingMs !== undefined ? new Date(Date.now() + payload.remainingMs).toISOString() : m.endsAt,
                }
              : m
          )
        );
      })
    );

    unsubs.push(
      ws.on('game:userMarket:bet', (payload: { roundId: string; targetWord: string; participantId: string; participantName: string; guess: number; lockedOdds: number; liveCount: number }) => {
        setUserMarkets((prev) =>
          prev.map((m) => {
            if (m.roundId !== payload.roundId) return m;
            const myBet =
              payload.participantId === participantId
                ? { guess: payload.guess, lockedOdds: payload.lockedOdds }
                : m.myBet;
            return { ...m, myBet, liveCount: payload.liveCount };
          })
        );
      })
    );

    unsubs.push(
      ws.on('game:userMarket:resolved', (payload: { roundId: string; targetWord: string; actualCount: number; results: any[]; leaderboard: LeaderboardEntry[] }) => {
        setLeaderboard(payload.leaderboard);
        setUserMarkets((prev) =>
          prev.map((m) => (m.roundId === payload.roundId ? { ...m, resolved: true, actualCount: payload.actualCount, liveCount: payload.actualCount } : m))
        );
      })
    );

    unsubs.push(
      ws.on('game:userMarket:error', (payload: { message: string }) => {
        setUserMarketError(payload.message);
        setTimeout(() => setUserMarketError(null), 5000);
      })
    );

    // ── Buzzword Bingo (always-on) ──
    unsubs.push(
      ws.on('bingo:open', (payload: { roundId: string; roundNumber: number }) => {
        setBingo((prev) => {
          if (prev && prev.roundId === payload.roundId) return prev;
          return prev
            ? { ...prev, roundId: payload.roundId, roundNumber: payload.roundNumber, myMarks: [], winner: null }
            : prev;
        });
      })
    );

    unsubs.push(
      ws.on('bingo:mark', (payload: { roundId: string; indices: number[] }) => {
        setBingo((prev) => {
          if (!prev || prev.roundId !== payload.roundId) return prev;
          const myMarks = Array.from(new Set([...prev.myMarks, ...payload.indices]));
          return { ...prev, myMarks };
        });
      })
    );

    unsubs.push(
      ws.on('bingo:win', (payload: { roundId: string; roundNumber: number; participantId: string; participantName: string; lineType: string }) => {
        setBingo((prev) =>
          prev && prev.roundId === payload.roundId
            ? { ...prev, winner: { participantId: payload.participantId, participantName: payload.participantName } }
            : prev
        );
      })
    );

    // ── Um-O-Meter / share-of-voice stats ──
    unsubs.push(
      ws.on('stats:update', (payload: { stats: RoomStateSnapshot['stats'] }) => {
        setStats(payload.stats ?? []);
      })
    );

    return () => unsubs.forEach((u) => u());
  }, [ws, participantId, liveKitRoom]);

  // ---------------------------------------------------------------------
  // LiveKit resilience: reconnect automatically after an unexpected drop.
  // A network blip disconnects the room; instead of showing a permanent
  // "audio/video unavailable" banner we silently retry with backoff and
  // only surface the error if reconnection fails.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!liveKitRoom) return;

    const onDisconnected = () => {
      if (intentionallyLeftRef.current) return; // user left — no reconnect
      const params = lkParamsRef.current;
      if (!params || reconnectInFlightRef.current) return;

      console.warn('[meeting] LiveKit disconnected — attempting reconnect…');
      setLiveKitConnected(false);
      setLiveKitReconnecting(true);
      setLivekitError(null); // don't show the red banner while retrying
      reconnectInFlightRef.current = true;

      reconnectLiveKit(
        params.roomName,
        params.identity,
        params.participantName,
        params.token,
        params.url,
        {
          shouldStop: () => intentionallyLeftRef.current,
          onRetry: (attempt, delay) =>
            console.warn(`[meeting] reconnect attempt ${attempt + 1} in ${delay}ms`),
        },
      ).then((result) => {
        reconnectInFlightRef.current = false;
        if (intentionallyLeftRef.current) {
          // Meeting ended while a reconnect was in flight — drop the new
          // connection instead of restoring a zombie room.
          result?.room?.disconnect();
          return;
        }
        if (result && !result.error) {
          console.log('[meeting] LiveKit reconnected');
          setLiveKitRoom(result.room);
          setLiveKitConnected(true);
          setLiveKitReconnecting(false);
          setLivekitError(null);
        } else {
          console.error('[meeting] LiveKit reconnect failed:', result?.error);
          setLiveKitReconnecting(false);
          setLivekitError(result?.error ?? 'Lost connection to the media server.');
        }
      });
    };

    liveKitRoom.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      liveKitRoom.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [liveKitRoom]);

  const createAndJoin = useCallback(async (name?: string, password?: string): Promise<string> => {
    intentionallyLeftRef.current = false;
    const result = await api.createRoom(name, password);
    roomTokenRef.current = result.token;
    roomIdRef.current = result.room.id;
    setRoom(result.room as Room);
    setParticipantId(result.participant.id);
    setParticipantName(result.participant.name || 'Host');
    setIsHost(true);
    setLivekitUrl(result.livekitUrl);
    setParticipants([{ id: result.participant.id, name: result.participant.name || 'Host', isHost: true, isMuted: false, isCameraOff: false }]);

    // Connect WebSocket
    ws.connect(result.room.id, result.participant.id, result.token);

    saveSessionSnapshot({
      roomId: result.room.id,
      participantId: result.participant.id,
      participantName: result.participant.name || 'Host',
      isHost: true,
      livekitUrl: result.livekitUrl,
      token: result.token,
      password,
    });

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
      lkParamsRef.current = {
        roomName: result.room.id,
        identity: result.participant.id,
        participantName: result.participant.name || 'Host',
        token: lkToken.token,
        url: result.livekitUrl,
      };
      const { room: lkRoom, error } = await connectToLiveKitWithRetry(
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
    intentionallyLeftRef.current = false;
    const result = await api.joinRoom(roomId, name, password);
    roomTokenRef.current = result.token;
    roomIdRef.current = result.room.id;
    setRoom(result.room as Room);
    setParticipantId(result.participant.id);
    setParticipantName(result.participant.name);
    setIsHost(false);
    setLivekitUrl(result.livekitUrl);
    setParticipants([{ id: result.participant.id, name: result.participant.name, isHost: false, isMuted: false, isCameraOff: false }]);

    // Connect WebSocket
    ws.connect(result.room.id, result.participant.id, result.token);

    saveSessionSnapshot({
      roomId: result.room.id,
      participantId: result.participant.id,
      participantName: result.participant.name,
      isHost: false,
      livekitUrl: result.livekitUrl,
      token: result.token,
      password,
    });

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
      lkParamsRef.current = {
        roomName: result.room.id,
        identity: result.participant.id,
        participantName: result.participant.name,
        token: lkToken.token,
        url: result.livekitUrl,
      };
      const { room: lkRoom, error } = await connectToLiveKitWithRetry(
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

  /**
   * Resume a meeting after an accidental refresh. Rejoins the room via the
   * same userId — the server reuses the existing participant row (no
   * duplicate) — then restores WS + LiveKit + host status.
   * Returns true on success.
   */
  const resumeSession = useCallback(async (): Promise<boolean> => {
    const snap = getSessionSnapshot();
    if (!snap) return false;

    intentionallyLeftRef.current = false;
    try {
      const result = await api.joinRoom(snap.roomId, snap.participantName, snap.password);
      roomTokenRef.current = result.token;
      roomIdRef.current = result.room.id;
      setRoom(result.room as Room);
      setParticipantId(result.participant.id);
      setParticipantName(result.participant.name);
      setIsHost(snap.isHost); // restore host status (WS room:state also syncs it)
      setLivekitUrl(result.livekitUrl);
      setParticipants([{ id: result.participant.id, name: result.participant.name, isHost: snap.isHost, isMuted: false, isCameraOff: false }]);

      ws.connect(result.room.id, result.participant.id, result.token);

      // Re-fetch chat history
      try {
        const history = await api.getChatHistory(snap.roomId);
        setMessages(history.messages);
      } catch {
        /* no history */
      }

      // LiveKit: same token flow; retry wrapper handles transient blips.
      if (result.livekitAvailable === false) {
        setLivekitError('The media server is not running or unreachable.');
        setLiveKitConnected(false);
      } else {
        const lkToken = await api.getLiveKitToken(
          result.room.id,
          result.participant.id,
          result.participant.name,
          result.token
        );
        lkParamsRef.current = {
          roomName: result.room.id,
          identity: result.participant.id,
          participantName: result.participant.name,
          token: lkToken.token,
          url: result.livekitUrl,
        };
        const { room: lkRoom, error } = await connectToLiveKitWithRetry(
          result.room.id,
          result.participant.id,
          result.participant.name,
          lkToken.token,
          result.livekitUrl
        );
        if (error) {
          console.error('[meeting] LiveKit reconnect error after refresh:', error);
          setLivekitError(error);
          setLiveKitConnected(false);
        } else {
          setLivekitError(null);
          setLiveKitConnected(true);
        }
        setLiveKitRoom(lkRoom);
      }
      return true;
    } catch (e) {
      console.error('[meeting] resumeSession failed:', e);
      clearSessionSnapshot();
      return false;
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

  /**
   * End the meeting for EVERYONE (host power).
   * Sends `room:end` over WS (server broadcasts + hard-deletes the LiveKit
   * room) AND fires the HTTP endpoint as an idempotent fallback so the room
   * still ends if the host's WS is down (e.g. right after a network blip).
   */
  const endMeeting = useCallback(() => {
    const token = api.getRoomToken();
    const roomId = roomIdRef.current;
    // End is final: never auto-reconnect, even if the broadcast is delayed
    // and the server-side room deletion races our disconnect.
    intentionallyLeftRef.current = true;
    reconnectInFlightRef.current = false;
    ws.send('room:end', {});
    if (token && roomId) {
      api
        .endRoom(roomId, token)
        .then(() => {
          // If our WS was dead and the broadcast never arrived, finish the
          // local cleanup now (the App route navigates to recap on 'ended').
          setRoom((prev) => (prev ? { ...prev, state: 'ended' } : prev));
          intentionallyLeftRef.current = true;
          ws.disconnect();
          liveKitRoom?.disconnect();
          setLiveKitRoom(null);
          setLiveKitConnected(false);
          api.clearRoomToken();
        })
        .catch((e) => console.error('[meeting] endRoom HTTP fallback failed:', e));
    }
  }, [ws, liveKitRoom]);

  const muteParticipant = useCallback((targetId: string, muted = true) => {
    ws.send('participant:mute', { targetId, muted });
  }, [ws]);

  const startRecording = useCallback(() => {
    setRecordingError(null);
    setRecordingResult(null);
    ws.send('recording:start', {});
  }, [ws]);

  const stopRecording = useCallback(() => {
    ws.send('recording:stop', {});
  }, [ws]);

  const setParticipantCamera = useCallback((targetId: string, cameraOff: boolean) => {
    ws.send('participant:camera', { targetId, cameraOff });
  }, [ws]);

  const removeParticipant = useCallback((targetId: string) => {
    ws.send('participant:remove', { targetId });
  }, [ws]);

  const lockRoom = useCallback(() => {
    ws.send('room:lock', {});
  }, [ws]);

  const leave = useCallback(() => {
    intentionallyLeftRef.current = true;
    reconnectInFlightRef.current = false;
    ws.disconnect();
    liveKitRoom?.disconnect();
    setLiveKitRoom(null);
    setLiveKitConnected(false);
    setLiveKitReconnecting(false);
    setLivekitError(null);
    setRoom(null);
    setParticipants([]);
    setMessages([]);
    setCaptions([]);
    setRecording(false);
    setRecordingResult(null);
    setRecordingError(null);
    api.clearRoomToken();
    clearSessionSnapshot();
  }, [ws, liveKitRoom]);

  const sendCaption = useCallback((speakerId: string, text: string, isFinal: boolean) => {
    ws.send('caption:event', { speakerId, text, isFinal });
  }, [ws]);

  // Quiet mode: watch LiveKit for any active screen-share track.
  // When a participant starts presenting, game notifications suspend.
  useEffect(() => {
    if (!liveKitRoom) {
      setGameQuiet(false);
      return;
    }
    const update = () => {
      const anySharing = Array.from(liveKitRoom.remoteParticipants.values()).some(
        (p) => p.isScreenShareEnabled
      ) || liveKitRoom.localParticipant.isScreenShareEnabled;
      setGameQuiet(anySharing);
    };
    const onTrackSub = (p: any) => {
      const pub = p?.getTrackPublications?.().find((t: any) => t.source === 'screen_share');
      pub?.on('subscribed', update);
      pub?.on('unsubscribed', update);
    };
    liveKitRoom.localParticipant.on('trackPublished', update);
    liveKitRoom.localParticipant.on('trackUnpublished', update);
    liveKitRoom.on('participantConnected', onTrackSub);
    liveKitRoom.on('participantDisconnected', update);
    update();
    const interval = setInterval(update, 2000); // safety net for edge cases
    return () => {
      clearInterval(interval);
      liveKitRoom.localParticipant.off('trackPublished', update);
      liveKitRoom.localParticipant.off('trackUnpublished', update);
      liveKitRoom.off('participantConnected', onTrackSub);
      liveKitRoom.off('participantDisconnected', update);
    };
  }, [liveKitRoom]);

  const submitAnswer = useCallback((roundId: string, answer: unknown) => {
    ws.send('game:submit', { roundId, answer });
  }, [ws]);

  const placeMarketBet = useCallback((guess: number) => {
    setMarket((prev) => {
      if (prev && !prev.resolved && !prev.myBet) {
        // optimistic local lock; server confirms via game:market:bet
        return { ...prev, myBet: { guess, lockedOdds: 1 } };
      }
      return prev;
    });
    const marketRef = market;
    if (marketRef && !marketRef.resolved) {
      ws.send('game:submit', { roundId: marketRef.roundId, answer: { guess } });
    }
  }, [ws, market]);

  const placeFlashBet = useCallback((roundId: string, guess: number) => {
    setFlash((prev) => {
      if (prev && prev.roundId === roundId && !prev.resolved && !prev.myBet) {
        // optimistic local lock; server confirms via game:flash:bet
        return { ...prev, myBet: { guess, lockedOdds: 1 } };
      }
      return prev;
    });
    ws.send('game:submit', { roundId, answer: { guess } });
  }, [ws]);

  const createUserMarket = useCallback((word: string, guess: number, durationSec?: number) => {
    ws.send('game:userMarket:create', { word, guess, durationSec });
  }, [ws]);

  const placeUserMarketBet = useCallback((roundId: string, guess: number) => {
    setUserMarkets((prev) =>
      prev.map((m) =>
        m.roundId === roundId && !m.resolved && !m.myBet
          ? { ...m, myBet: { guess, lockedOdds: 1 } }
          : m
      )
    );
    ws.send('game:submit', { roundId, answer: { guess } });
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
    liveKitReconnecting,
    livekitError,
    messages,
    leaderboard,
    activeRound,
    market,
    flash,
    userMarkets,
    userMarketError,
    bingo,
    stats,
    livekitUrl,
    captions,
    gameQuiet,
    recording,
    recordingResult,
    recordingError,
  };

  const actions = useMemo<MeetingActions>(
    () => ({
      createAndJoin,
      joinRoom,
      resumeSession,
      sendChat,
      sendEmoji,
      toggleHand,
      toggleTranscription,
      endMeeting,
      startRecording,
      stopRecording,
      muteParticipant,
      setParticipantCamera,
      removeParticipant,
      lockRoom,
      leave,
      sendCaption,
      submitAnswer,
      placeMarketBet,
      placeFlashBet,
      createUserMarket,
      placeUserMarketBet,
    }),
    [
      createAndJoin,
      joinRoom,
      resumeSession,
      sendChat,
      sendEmoji,
      toggleHand,
      toggleTranscription,
      endMeeting,
      startRecording,
      stopRecording,
      muteParticipant,
      setParticipantCamera,
      removeParticipant,
      lockRoom,
      leave,
      sendCaption,
      submitAnswer,
      placeMarketBet,
      placeFlashBet,
      createUserMarket,
      placeUserMarketBet,
    ]
  );

  return [state, actions];
}