export type GameType = 'who_said_that' | 'scrabble' | 'word_count_bet';

/** Games players can start from the meeting game menu (flash WCB is automatic). */
export type StartableGameType = 'who_said_that' | 'scrabble' | 'bingo';

export type RoundState = 'idle' | 'open' | 'locked' | 'scored';

export interface GameRound {
  id: string;
  gameType: GameType;
  state: RoundState;
  roundData: unknown;
  timeLimit: number;
  startedAt: string;
}

export interface GameSubmission {
  roundId: string;
  participantId: string;
  participantName: string;
  submission: unknown;
  score: number;
}

export interface LeaderboardEntry {
  participantId: string;
  participantName: string;
  score: number;
  pointsPerRound: number;
  roundsPlayed: number;
}

export type TileShape = '16:9' | '4:3' | 'fill';

export interface RoomStateSnapshot {
  participants: Array<{
    id: string;
    name: string;
    isHost: boolean;
    isMuted: boolean;
    isCameraOff: boolean;
    /** Hand raised right now (server-tracked, so a resync cannot drop it). */
    handRaised: boolean;
  }>;
  transcriptionEnabled: boolean;
  /** Host-selected tile shape. Absent from older servers -> treated as 16:9. */
  tileShape?: TileShape;
  roomState: 'active' | 'locked' | 'ended';
  recording: boolean;
  /**
   * Whether the server can start a recording at all (LiveKit + an S3
   * destination configured). Optional: older servers omit it, and the client
   * then assumes available and surfaces the server's recording:error instead.
   */
  recordingAvailable?: boolean;
  /** Why recording is unavailable, verbatim from the server (null when available). */
  recordingReason?: string | null;
  activeRound: {
    roundId: string;
    gameType: string;
    state: string;
    roundData: unknown;
    timeLimit: number;
    startedAt: string;
  } | null;
  leaderboard: LeaderboardEntry[];
  market: {
    roundId: string;
    targetWord: string;
    startedAt: string;
    liveCount: number;
    odds: Record<string, number>;
    myBet: { guess: number; lockedOdds: number } | null;
    resolved: boolean;
    actualCount?: number;
  } | null;
  flash: {
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
  } | null;
  userMarkets: Array<{
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
  }>;
  bingo: {
    roundId: string;
    roundNumber: number;
    myCard: string[];
    myMarks: number[];
    winner: { participantId: string; participantName: string } | null;
  } | null;
  stats: Array<{
    participantId: string;
    participantName: string;
    words: number;
    utterances: number;
    fillers: number;
    shareOfVoice: number;
  }>;
}