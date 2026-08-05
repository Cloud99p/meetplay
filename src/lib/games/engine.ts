import type { GameType, RoundState } from '../../types/games';

export interface RoundInfo {
  roundId: string;
  gameType: GameType;
  state: RoundState;
  roundData: unknown;
  timeLimit: number;
  startedAt: string;
}

/**
 * Client-side game utilities.
 */

export function getRoundTimeRemaining(startedAt: string, timeLimit: number): number {
  const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000;
  return Math.max(0, timeLimit - elapsed);
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