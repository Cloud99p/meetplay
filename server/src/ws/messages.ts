import { z } from 'zod';

// ─── Client → Server Messages ─────────────────────────

export const ChatSendPayload = z.object({ content: z.string().min(1).max(2000) });
export const EmojiSendPayload = z.object({ emoji: z.string().min(1).max(8) });
export const HandRaisePayload = z.object({});
export const HandLowerPayload = z.object({});
export const CaptionEventPayload = z.object({
  speakerId: z.string(),
  text: z.string(),
  isFinal: z.boolean().optional(),
});
export const GameSubmitPayload = z.object({
  roundId: z.string().uuid(),
  answer: z.unknown(),
});
export const GameStartPayload = z.object({
  gameType: z.enum(['who_said_that', 'scrabble', 'bingo']),
});
export const UserMarketCreatePayload = z.object({
  word: z.string().min(1).max(30),
  guess: z.number().int().min(0).max(9999),
  durationSec: z.number().int().min(0).max(600).optional(),
});
export const ParticipantMutePayload = z.object({
  targetId: z.string().uuid(),
  muted: z.boolean().optional(),
});
export const ParticipantCameraPayload = z.object({
  targetId: z.string().uuid(),
  cameraOff: z.boolean().optional(),
});
export const ParticipantRemovePayload = z.object({ targetId: z.string().uuid() });
export const RoomLockPayload = z.object({});
export const RoomEndPayload = z.object({});
export const RecordingStartPayload = z.object({});
export const RecordingStopPayload = z.object({});

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat:send'), payload: ChatSendPayload }),
  z.object({ type: z.literal('emoji:send'), payload: EmojiSendPayload }),
  z.object({ type: z.literal('hand:raise'), payload: HandRaisePayload }),
  z.object({ type: z.literal('hand:lower'), payload: HandLowerPayload }),
  z.object({ type: z.literal('caption:event'), payload: CaptionEventPayload }),
  z.object({ type: z.literal('game:submit'), payload: GameSubmitPayload }),
  z.object({ type: z.literal('game:start'), payload: GameStartPayload }),
  z.object({ type: z.literal('game:userMarket:create'), payload: UserMarketCreatePayload }),
  z.object({ type: z.literal('participant:mute'), payload: ParticipantMutePayload }),
  z.object({ type: z.literal('participant:camera'), payload: ParticipantCameraPayload }),
  z.object({ type: z.literal('participant:remove'), payload: ParticipantRemovePayload }),
  z.object({ type: z.literal('room:lock'), payload: RoomLockPayload }),
  z.object({ type: z.literal('room:end'), payload: RoomEndPayload }),
  z.object({ type: z.literal('recording:start'), payload: RecordingStartPayload }),
  z.object({ type: z.literal('recording:stop'), payload: RecordingStopPayload }),
]);

export type TClientMessage = z.infer<typeof ClientMessage>;

// ─── Server → Client Messages ─────────────────────────

export type ServerMessage =
  | { type: 'chat:received'; payload: { id: string; participantId: string; participantName: string; content: string; createdAt: string } }
  | { type: 'emoji:received'; payload: { participantId: string; participantName: string; emoji: string } }
  | { type: 'hand:raised'; payload: { participantId: string; participantName: string } }
  | { type: 'hand:lowered'; payload: { participantId: string } }
  | { type: 'caption:event'; payload: { speakerId: string; participantName: string | null; text: string; isFinal: boolean; timestamp: number } }
  | { type: 'game:round:open'; payload: { roundId: string; gameType: string; question: unknown; timeLimit: number } }
  | { type: 'game:start:rejected'; payload: { reason: string } }
  | { type: 'game:round:locked'; payload: { roundId: string } }
  | { type: 'game:round:scored'; payload: { roundId: string; results: Array<Record<string, unknown>>; leaderboard: LeaderboardEntry[] } }
  | { type: 'game:market:open'; payload: { roundId: string; targetWord: string; startedAt: string } }
  | { type: 'game:market:update'; payload: { roundId: string; targetWord: string; liveCount: number; odds: Record<string, number> } }
  | { type: 'game:market:bet'; payload: { roundId: string; participantId: string; participantName: string; guess: number; lockedOdds: number; liveCount: number } }
  | { type: 'game:market:resolved'; payload: { roundId: string; targetWord: string; actualCount: number; results: Array<Record<string, unknown>>; leaderboard: LeaderboardEntry[] } }
  | { type: 'game:flash:open'; payload: { roundId: string; targetWord: string; windowMs: number; startedAt: string; endsAt: string } }
  | { type: 'game:flash:update'; payload: { roundId: string; targetWord: string; liveCount: number; odds: Record<string, number>; remainingMs: number } }
  | { type: 'game:flash:bet'; payload: { roundId: string; participantId: string; participantName: string; guess: number; lockedOdds: number; liveCount: number } }
  | { type: 'game:flash:resolved'; payload: { roundId: string; targetWord: string; windowMs: number; actualCount: number; results: Array<Record<string, unknown>>; leaderboard: LeaderboardEntry[] } }
  | { type: 'game:userMarket:open'; payload: { roundId: string; targetWord: string; createdBy: string; createdByName: string; startedAt: string; durationSec?: number; endsAt?: string } }
  | { type: 'game:userMarket:update'; payload: { roundId: string; targetWord: string; liveCount: number; odds: Record<string, number>; remainingMs?: number } }
  | { type: 'game:userMarket:bet'; payload: { roundId: string; targetWord: string; participantId: string; participantName: string; guess: number; lockedOdds: number; liveCount: number } }
  | { type: 'game:userMarket:resolved'; payload: { roundId: string; targetWord: string; actualCount: number; results: Array<Record<string, unknown>>; leaderboard: LeaderboardEntry[] } }
  | { type: 'game:userMarket:error'; payload: { message: string } }
  | { type: 'bingo:open'; payload: { roundId: string; roundNumber: number } }
  | { type: 'bingo:mark'; payload: { roundId: string; indices: number[] } }
  | { type: 'bingo:win'; payload: { roundId: string; roundNumber: number; participantId: string; participantName: string; lineType: string } }
  | { type: 'stats:update'; payload: { stats: SpeakerStatRow[] } }
  | { type: 'participant:joined'; payload: { id: string; name: string } }
  | { type: 'participant:left'; payload: { id: string } }
  | { type: 'participant:muted'; payload: { targetId: string; isMuted: boolean } }
  | { type: 'participant:camera'; payload: { targetId: string; isCameraOff: boolean } }
  | { type: 'participant:removed'; payload: { targetId: string } }
  | { type: 'room:locked'; payload: Record<string, never> }
  | { type: 'room:ended'; payload: Record<string, never> }
  | { type: 'recording:started'; payload: { recording: true; startedAt: number } }
  | { type: 'recording:stopped'; payload: { recording: false; downloadUrl: string | null; filename: string | null } }
  | { type: 'recording:error'; payload: { message: string } }
  | { type: 'host:promoted'; payload: { participantId: string } }
  | { type: 'transcript:toggled'; payload: { enabled: boolean } }
  | { type: 'room:state'; payload: RoomStateSnapshot };

export interface SpeakerStatRow {
  participantId: string;
  participantName: string;
  words: number;
  utterances: number;
  fillers: number;
  shareOfVoice: number;
}

export interface MarketSnapshot {
  roundId: string;
  targetWord: string;
  startedAt: string;
  liveCount: number;
  odds: Record<string, number>;
  myBet: { guess: number; lockedOdds: number } | null;
  resolved: boolean;
  actualCount?: number;
}

export interface BingoSapshot {
  roundId: string;
  roundNumber: number;
  myCard: string[];
  myMarks: number[];
  winner: { participantId: string; participantName: string } | null;
}

export interface FlashSnapshot {
  roundId: string;
  targetWord: string;
  windowMs: number;
  startedAt: string;
  endsAt: string;
  liveCount: number;
  odds: Record<string, number>;
  myBet: { guess: number; lockedOdds: number } | null;
  resolved: boolean;
  actualCount?: number;
}

export interface UserMarketSnapshot {
  roundId: string;
  targetWord: string;
  createdBy: string;
  createdByName: string;
  startedAt: string;
  endsAt?: string;
  durationSec?: number;
  liveCount: number;
  odds: Record<string, number>;
  myBet: { guess: number; lockedOdds: number } | null;
  resolved: boolean;
  actualCount?: number;
}

export interface RoomStateSnapshot {
  participants: Array<{ id: string; name: string; isHost: boolean; isMuted: boolean; isCameraOff: boolean }>;
  transcriptionEnabled: boolean;
  roomState: 'active' | 'locked' | 'ended';
  recording: boolean;
  activeRound: {
    roundId: string;
    gameType: string;
    state: string;
    roundData: unknown;
    timeLimit: number;
    startedAt: string;
  } | null;
  leaderboard: LeaderboardEntry[];
  market: MarketSnapshot | null;
  flash: FlashSnapshot | null;
  userMarkets: UserMarketSnapshot[];
  bingo: BingoSapshot | null;
  stats: SpeakerStatRow[];
}

export interface LeaderboardEntry {
  participantId: string;
  participantName: string;
  score: number;
  pointsPerRound: number;
  roundsPlayed: number;
}

export function encode(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export function decode(data: string): TClientMessage | null {
  try {
    const parsed = JSON.parse(data);
    return ClientMessage.parse(parsed);
  } catch {
    return null;
  }
}