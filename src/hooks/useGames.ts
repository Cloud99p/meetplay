import { useState, useEffect } from 'react';
import type { LeaderboardEntry, RoomStateSnapshot } from '../types/games';
import { useWebSocket } from './useWebSocket';

export interface UseGamesResult {
  activeRound: RoomStateSnapshot['activeRound'];
  leaderboard: LeaderboardEntry[];
  submit: (answer: unknown) => void;
}

/**
 * Subscribes to game events via the shared WebSocket client.
 */
export function useGames(): UseGamesResult {
  const ws = useWebSocket();
  const [activeRound, setActiveRound] = useState<RoomStateSnapshot['activeRound']>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);

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
      })
    );

    unsubs.push(
      ws.on('game:round:locked', (payload: { roundId: string }) => {
        setActiveRound((prev) => (prev?.roundId === payload.roundId ? { ...prev, state: 'locked' } : prev));
      })
    );

    unsubs.push(
      ws.on('game:round:scored', (payload: { roundId: string; results: any[]; leaderboard: LeaderboardEntry[] }) => {
        setLeaderboard(payload.leaderboard);
        setActiveRound((prev) => (prev?.roundId === payload.roundId ? { ...prev, state: 'scored' } : prev));
      })
    );

    return () => unsubs.forEach((u) => u());
  }, [ws]);

  const submit = (answer: unknown) => {
    if (activeRound) {
      ws.send('game:submit', { roundId: activeRound.roundId, answer });
    }
  };

  return { activeRound, leaderboard, submit };
}