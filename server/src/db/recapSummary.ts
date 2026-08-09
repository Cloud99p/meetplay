/**
 * Shared recap summary computation — the SINGLE source of truth for
 * leaderboard + key quotes scoring.
 *
 * Both DB backends (memory.ts and pgQueries.ts) fetch raw rows, assemble the
 * same `RecapBase` shape, and call `withSummary()` here. A scoring change is
 * made once, never twice, so the backends can't drift.
 *
 * Pure function: no I/O, no imports from either backend.
 */

export interface RecapBase {
  room: {
    id: string;
    name: string | null;
    createdAt: string; // ISO
    endedAt: string | null; // ISO
    duration: number;
  };
  participants: Array<{
    id: string;
    name: string;
    isHost: boolean;
    joinedAt: string; // ISO
  }>;
  transcript: Array<{
    id: string;
    participantName: string;
    text: string;
    createdAt: string; // ISO
  }>;
  gameRounds: Array<{
    id: string;
    gameType: string;
    roundData: unknown;
    startedAt: string; // ISO
    endedAt: string | null; // ISO
    state: string;
    submissions: Array<{
      participantId: string;
      participantName: string;
      submission: unknown;
      score: number;
    }>;
  }>;
}

export interface LeaderboardEntry {
  participantId: string;
  participantName: string;
  score: number;
  pointsPerRound: number;
  roundsPlayed: number;
}

export interface KeyQuote {
  quote: string;
  speakerName: string;
  correctGuesses: number;
  totalGuesses: number;
}

export interface RecapData extends RecapBase {
  leaderboard: LeaderboardEntry[];
  keyQuotes: KeyQuote[];
}

/**
 * Compute leaderboard (pointsPerRound primary, total tiebreak) and key quotes
 * (Who Said That quotes ranked by correct-guess count).
 */
export function withSummary(recap: RecapBase): RecapData {
  // ---- Leaderboard ----
  const totals = new Map<string, { total: number; roundsPlayed: number; name: string }>();
  for (const p of recap.participants) {
    totals.set(p.id, { total: 0, roundsPlayed: 0, name: p.name });
  }
  for (const round of recap.gameRounds) {
    for (const s of round.submissions ?? []) {
      const entry = totals.get(s.participantId);
      if (!entry) continue;
      entry.total += s.score ?? 0;
      if (round.state === 'scored' || round.state === 'locked') {
        entry.roundsPlayed++;
      }
    }
  }
  const leaderboard: LeaderboardEntry[] = Array.from(totals.entries())
    .filter(([_, v]) => v.roundsPlayed > 0)
    .map(([id, v]) => ({
      participantId: id,
      participantName: v.name,
      score: v.total,
      pointsPerRound: v.roundsPlayed > 0 ? Math.round((v.total / v.roundsPlayed) * 100) / 100 : 0,
      roundsPlayed: v.roundsPlayed,
    }))
    .sort((a, b) => {
      const ppr = b.pointsPerRound - a.pointsPerRound;
      return ppr !== 0 ? ppr : b.score - a.score;
    });

  // ---- Key quotes ----
  const keyQuotes: KeyQuote[] = [];
  for (const round of recap.gameRounds) {
    if (round.gameType !== 'who_said_that') continue;
    const rd = round.roundData as { quote?: string; speakerId?: string } | null;
    if (!rd?.quote) continue;
    const speaker = recap.participants.find((p) => p.id === rd.speakerId);
    const subs = round.submissions ?? [];
    const correctGuesses = subs.filter(
      (s) => (s.submission as { answer?: string } | null)?.answer === rd.speakerId
    ).length;
    keyQuotes.push({
      quote: rd.quote,
      speakerName: speaker?.name ?? 'Unknown',
      correctGuesses,
      totalGuesses: subs.length,
    });
  }
  keyQuotes.sort((a, b) => b.correctGuesses - a.correctGuesses);

  return { ...recap, leaderboard, keyQuotes };
}
