// Client-side Word Count Bet market logic — mirrors server/src/games/market.ts
// (optimistic preview; server is authoritative).

export interface MarketBet {
  participantId: string;
  guess: number;
  lockedOdds: number;
  submittedAt: number;
}

/** Prediction-market style odds per guess value. Mirrors server. */
export function computeGuessOdds(bets: MarketBet[], liveCount: number): Record<string, number> {
  const weights = new Map<number, number>();
  for (const b of bets) {
    const w = 1 / (1 + Math.abs(b.guess - liveCount));
    weights.set(b.guess, (weights.get(b.guess) ?? 0) + w);
  }
  const total = Array.from(weights.values()).reduce((a, b) => a + b, 0);
  if (total <= 0) return {};

  const odds: Record<string, number> = {};
  for (const [g, w] of weights) {
    const p = w / total;
    const o = 1 / p;
    odds[String(g)] = Math.round(Math.min(20, Math.max(1.01, o)) * 100) / 100;
  }
  return odds;
}

export function oddsMultiplier(lockedOdds: number): number {
  return Math.min(5, Math.max(1, lockedOdds));
}

export function countWordInText(word: string, text: string): number {
  const lower = word.toLowerCase();
  const tokens = text.toLowerCase().replace(/[^a-z0-9'-]/g, ' ').split(/\s+/).filter(Boolean);
  let count = 0;
  for (const t of tokens) {
    if (t.includes(lower) || lower.includes(t)) count++;
  }
  return count;
}

export interface MarketState {
  roundId: string;
  targetWord: string;
  startedAt: string;
  liveCount: number;
  odds: Record<string, number>;
  myBet: { guess: number; lockedOdds: number } | null;
  resolved: boolean;
  actualCount?: number;
}
