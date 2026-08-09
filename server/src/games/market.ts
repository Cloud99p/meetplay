// Word Count Bet v2 — call-long prediction market.
//
// Unlike the old 60-second WCB round, the market opens at the start of the
// call and stays open until the room ends. Bets are locked at the odds
// current at submission time; when the meeting ends the actual count is
// revealed and each bet is scored as `closeness × oddsMultiplier` — so an
// early, correct long-shot pays more than a late crowd-follower.

export interface MarketBet {
  participantId: string;
  guess: number;
  /** Odds (multiplier) locked when this bet was placed. */
  lockedOdds: number;
  submittedAt: number;
}

/**
 * Prediction-market style odds per guess value.
 *
 * For every bet, closeness weight w = 1 / (1 + |guess − liveCount|).
 * Bets on the same number pool their weight. The implied probability of a
 * number is its share of total weight; odds = 1 / probability.
 *
 * A new bet on a number pushes that number's odds DOWN (crowd effect);
 * the live count moving makes nearby guesses more likely — both shift the
 * odds in real time, which is exactly the drama we want.
 */
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

/** The score multiplier implied by a locked odds value (capped ×1–×5). */
export function oddsMultiplier(lockedOdds: number): number {
  return Math.min(5, Math.max(1, lockedOdds));
}

/** Count how many times the target word appears in an utterance.
 *
 * Partial matches count ('roadmaps'/'roadmapping' match 'roadmap'), but only
 * when the overlap is a meaningful stem — a token like 'a' or 'is' must NOT
 * match a longer target word just because it's a substring of it. The old
 * `t.includes(lower) || lower.includes(t)` matched any token that shares a
 * letter sequence (e.g. target 'roadmap' counted the token 'a', and target
 * 'hello' never matched cleanly). Rules:
 *   - exact match counts
 *   - token starts with the target (plural/derivatives) counts
 *   - target starts with the token ONLY if the token is >= 4 chars (avoids
 *     matching stopwords like 'a', 'to', 'is' inside longer words)
 */
export function countWordInText(word: string, text: string): number {
  const lower = word.toLowerCase();
  const tokens = text.toLowerCase().replace(/[^a-z0-9'-]/g, ' ').split(/\s+/).filter(Boolean);
  let count = 0;
  for (const t of tokens) {
    if (t === lower) { count++; continue; }
    if (t.startsWith(lower)) { count++; continue; }
    if (lower.startsWith(t) && t.length >= 4) count++;
  }
  return count;
}
