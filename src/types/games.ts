export type GameType = 'who_said_that' | 'scrabble' | 'word_count_bet';

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

export interface RoomStateSnapshot {
  participants: Array<{
    id: string;
    name: string;
    isHost: boolean;
    isMuted: boolean;
    isCameraOff: boolean;
  }>;
  transcriptionEnabled: boolean;
  roomState: 'active' | 'locked' | 'ended';
  activeRound: {
    roundId: string;
    gameType: string;
    state: string;
    roundData: unknown;
    timeLimit: number;
    startedAt: string;
  } | null;
  leaderboard: LeaderboardEntry[];
}