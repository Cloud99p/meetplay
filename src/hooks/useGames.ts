import { useState, useEffect, useRef } from 'react';
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

  // After a round is scored we keep the trophy screen visible for a short
  // beat so players see the result, then clear activeRound so the "Start a
  // game" menu comes back and they can play another round. Without this the
  // client held the round in 'scored' state forever, hiding the menu and
  // making every game a one-round-and-done dead end.
  const SCORED_CLEAR_MS = 4000;
  const scoredClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      ws.on('game:round:open', (payload: { roundId: string; gameType: string; question: unknown; timeLimit: number }) => {
        // A new round is starting — cancel any pending scored-clear timer so it
        // can't wipe out the fresh round.
        if (scoredClearTimerRef.current) {
          clearTimeout(scoredClearTimerRef.current);
          scoredClearTimerRef.current = null;
        }
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

        // Show the trophy, then automatically drop back to the game menu so
        // another round can be started.
        if (scoredClearTimerRef.current) clearTimeout(scoredClearTimerRef.current);
        scoredClearTimerRef.current = setTimeout(() => {
          setActiveRound((prev) => (prev?.state === 'scored' ? null : prev));
        }, SCORED_CLEAR_MS);
      })
    );

    return () => {
      if (scoredClearTimerRef.current) clearTimeout(scoredClearTimerRef.current);
      unsubs.forEach((u) => u());
    };
  }, [ws]);

  const submit = (answer: unknown) => {
    if (activeRound) {
      ws.send('game:submit', { roundId: activeRound.roundId, answer });
    }
  };

  return { activeRound, leaderboard, submit, quiet, lastEvent };
}
