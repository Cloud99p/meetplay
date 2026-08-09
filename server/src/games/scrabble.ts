import type { UtteranceInfo } from './qualityGate.js';

export interface ScrabbleRound {
  bank: string[];
  /** Shuffled letter tiles derived from real meeting words (duplicates possible). */
  pool: string[];
}

const MIN_WORD_LENGTH = 2;
const POOL_MAX_LETTERS = 24;

/**
 * Build a Letter Tiles round from utterances:
 *  - bank: unique words said in the meeting (lowercase, min 2 chars)
 *  - pool: letters harvested from a random subset of bank words, shuffled.
 *    Words are added greedily until the pool is full, so every harvested
 *    word is guaranteed formable from the tiles. The bank itself is NOT
 *    shown to players — they must recall words from the meeting.
 */
export function buildScrabbleRound(utterances: UtteranceInfo[]): ScrabbleRound {
  const words = new Set<string>();
  for (const u of utterances) {
    const tokens = u.text
      .toLowerCase()
      .replace(/[^a-z0-9'-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= MIN_WORD_LENGTH && /[a-z]/.test(w));
    for (const t of tokens) {
      words.add(t);
    }
  }
  const bank = Array.from(words).sort();

  const shuffled = [...bank].sort(() => Math.random() - 0.5);
  const letters: string[] = [];
  for (const w of shuffled) {
    if (letters.length >= POOL_MAX_LETTERS) break;
    letters.push(...w.split(''));
  }
  // Fisher-Yates shuffle of the tile pool
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }

  return { bank, pool: letters };
}

/** A word is in the bank (word must have been said in the meeting). */
export function validateWord(word: string, bank: string[]): boolean {
  return bank.includes(word.toLowerCase().trim());
}

/** Can the word be spelled with the tiles in the pool (letter counts)? */
export function canFormWord(word: string, pool: string[]): boolean {
  const counts = new Map<string, number>();
  for (const l of pool) counts.set(l, (counts.get(l) ?? 0) + 1);
  for (const ch of word.toLowerCase()) {
    const c = counts.get(ch) ?? 0;
    if (c <= 0) return false;
    counts.set(ch, c - 1);
  }
  return true;
}

/** Points by word length: 2→100, 3→200, 4→350, 5+→500. */
export function wordPoints(word: string): number {
  const len = word.length;
  if (len <= 2) return 100;
  if (len === 3) return 200;
  if (len === 4) return 350;
  return 500;
}

/**
 * Score a submission: length-based points per valid word (must be in the
 * bank AND spellable from the pool) + 500 uniqueness bonus if no other
 * submission played that word.
 */
export function calculateScore(
  words: string[],
  bank: string[],
  pool: string[],
  allSubmissions: Array<{ words: string[] }>
): { points: number; uniquenessBonus: number; wordDetails: Array<{ word: string; base: number; unique: boolean }> } {
  const uniqueWords = new Set(words.map((w) => w.toLowerCase().trim()));
  let totalPoints = 0;
  let totalBonus = 0;
  const wordDetails: Array<{ word: string; base: number; unique: boolean }> = [];

  for (const w of uniqueWords) {
    if (!validateWord(w, bank) || !canFormWord(w, pool)) continue;
    const isUnique = !allSubmissions.some(
      (s) => s.words.some((sw) => sw.toLowerCase().trim() === w)
    );
    const base = wordPoints(w);
    const bonus = isUnique ? 500 : 0;
    totalPoints += base + bonus;
    totalBonus += bonus;
    wordDetails.push({ word: w, base, unique: isUnique });
  }

  return {
    points: totalPoints,
    uniquenessBonus: totalBonus,
    wordDetails,
  };
}

export function scoreScrabble(
  submission: { words: string[] },
  roundData: ScrabbleRound,
  allSubmissions: Array<{ words: string[] }>
): number {
  const result = calculateScore(submission.words, roundData.bank, roundData.pool, allSubmissions);
  return result.points;
}
