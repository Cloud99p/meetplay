import type { GameType, RoundState, LeaderboardEntry } from '../../types/games';

export interface RoundInfo {
  roundId: string;
  gameType: GameType;
  state: RoundState;
  roundData: unknown;
  timeLimit: number;
  startedAt: string;
}

/**
 * Client-side game utilities — pure functions only, no I/O, no React.
 * Mirrors server/src/games/engine.ts scoring/state logic (optimistic preview;
 * the server remains authoritative).
 */

/** Transition a round state, returning the new state with timestamp. */
export function transitionState(
  _current: RoundState,
  next: RoundState,
  now: number = Date.now()
): { state: RoundState; timestamp: number } {
  return { state: next, timestamp: now };
}

/** Seconds remaining in a round. */
export function roundTimeLeft(startedAt: string, timeLimitSec: number): number {
  const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000;
  return Math.max(0, timeLimitSec - elapsed);
}

/** Backwards-compatible alias used by game components. */
export function getRoundTimeRemaining(startedAt: string, timeLimit: number): number {
  return roundTimeLeft(startedAt, timeLimit);
}

/** Sort leaderboard by pointsPerRound (or total score), descending. */
export function sortLeaderboard(
  entries: LeaderboardEntry[],
  byPointsPerRound = true
): LeaderboardEntry[] {
  return [...entries].sort((a, b) => {
    const av = byPointsPerRound ? a.pointsPerRound : a.score;
    const bv = byPointsPerRound ? b.pointsPerRound : b.score;
    return bv - av;
  });
}

export function formatTime(seconds: number): string {
  const s = Math.ceil(seconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function isGameType(type: string): type is GameType {
  return ['who_said_that', 'scrabble', 'word_count_bet'].includes(type);
}

export function getGameTypeLabel(type: GameType): string {
  switch (type) {
    case 'who_said_that': return 'Who Said That?';
    case 'scrabble': return 'Meeting Scrabble';
    case 'word_count_bet': return 'Word Count Bet';
  }
}
