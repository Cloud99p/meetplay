import type { UtteranceInfo } from './qualityGate.js';

export interface WordCountBetRound {
  targetWord: string;
  initialCount: number;
  actualCount?: number;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'i', 'you', 'he', 'she',
  'it', 'we', 'they', 'this', 'that', 'these', 'those', 'not', 'no',
  'nor', 'so', 'ok', 'yeah', 'hi', 'hello', 'hey', 'like', 'well',
  'right', 'okay', 'oh', 'ah', 'um', 'uh', 'hmm', 'got', 'get', 'let',
]);

/**
 * Select a target word from utterances — most frequent non-stopword, min 3 chars.
 */
export function selectTargetWord(utterances: UtteranceInfo[]): string {
  const freq = new Map<string, number>();
  for (const u of utterances) {
    const tokens = u.text
      .toLowerCase()
      .replace(/[^a-z0-9'-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && /[a-z]/.test(w));
    for (const t of tokens) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  let best = 'meeting';
  let bestCount = 0;
  for (const [word, count] of freq) {
    if (count > bestCount) {
      best = word;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Count occurrences of a word in utterances (case-insensitive, substring match).
 * e.g. 'roadmapping' matches 'roadmap'.
 */
export function countOccurrences(word: string, utterances: UtteranceInfo[]): number {
  const lower = word.toLowerCase();
  let count = 0;
  for (const u of utterances) {
    const tokens = u.text.toLowerCase().replace(/[^a-z0-9'-]/g, ' ').split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      // Substring match: target word appears as substring of token OR token appears as substring of target
      if (t.includes(lower) || lower.includes(t)) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Find the closest guess to the actual count.
 */
export function closestGuess(guesses: number[], correctCount: number): number {
  if (guesses.length === 0) return 0;
  return guesses.reduce((best, g) =>
    Math.abs(g - correctCount) < Math.abs(best - correctCount) ? g : best
  );
}

/**
 * Score a bet: max 1000 for exact, scale down by absolute difference.
 */
export function calculateBetScore(guess: number, actualCount: number): number {
  const delta = Math.abs(guess - actualCount);
  if (delta === 0) return 1000;
  if (delta <= 3) return Math.round(1000 - delta * 100); // 900-700
  if (delta <= 10) return Math.round(1000 - 300 - (delta - 3) * 30); // ~700 down
  return Math.max(50, Math.round(1000 - 300 - 7 * 30 - (delta - 10) * 10));
}

export function scoreWordCountBet(
  submission: { guess: number },
  roundData: WordCountBetRound
): number {
  return calculateBetScore(submission.guess, roundData.actualCount ?? roundData.initialCount);
}