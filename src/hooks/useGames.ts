import { useState, useEffect } from 'react';
import type { LeaderboardEntry, RoomStateSnapshot } from '../types/games';
import { useWebSocket } from './useWebSocket';

export interface UseGamesResult {
  activeRound: RoomStateSnapshot['activeRound'];
  leaderboard: LeaderboardEntry[];
  submit: (answer: unknown) => void;
  /** True while the host is screen-sharing/presenting — games suspend notifications. */
  quiet: boolean;
  /** Latest round events — used by GamesPanel to flash a badge (suppressed in quiet). */
  lastEvent: { type: string; at: number } | null;
}

/**
 * Subscribes to game events via the shared WebSocket client.
 *
 * Quiet mode: while `screenShareActive` is true (host presenting), games still
 * track state but suppress attention-drawing notifications. Round state keeps
 * syncing so nobody loses their place — it's notification-only suspension.
 */
export function useGames(screenShareActive = false): UseGamesResult {
  const ws = useWebSocket();
  const [activeRound, setActiveRound] = useState<RoomStateSnapshot['activeRound']>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [lastEvent, setLastEvent] = useState<{ type: string; at: number } | null>(null);
  const quiet = screenShareActive;

  useEffect(() => {
    const unsubs: Array<() => void> = [];

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
        setLastEvent({ type: 'open', at: Date.now() });
      })
    );

    unsubs.push(
      ws.on('game:round:locked', (payload: { roundId: string }) => {
        setActiveRound((prev) => (prev?.roundId === payload.roundId ? { ...prev, state: 'locked' } : prev));
        setLastEvent({ type: 'locked', at: Date.now() });
      })
    );

    unsubs.push(
      ws.on('game:round:scored', (payload: { roundId: string; results: any[]; leaderboard: LeaderboardEntry[] }) => {
        setLeaderboard(payload.leaderboard);
        setActiveRound((prev) => (prev?.roundId === payload.roundId ? { ...prev, state: 'scored' } : prev));
        setLastEvent({ type: 'scored', at: Date.now() });
      })
    );

    return () => unsubs.forEach((u) => u());
  }, [ws]);

  const submit = (answer: unknown) => {
    if (activeRound) {
      ws.send('game:submit', { roundId: activeRound.roundId, answer });
    }
  };

  return { activeRound, leaderboard, submit, quiet, lastEvent };
}
