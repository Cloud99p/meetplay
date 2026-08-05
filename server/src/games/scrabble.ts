import type { UtteranceInfo } from './qualityGate.js';

export interface ScrabbleRound {
  bank: string[];
}

const MIN_WORD_LENGTH = 2;

/**
 * Build a word bank from utterances — unique words, lowercase, min 2 chars.
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
  return { bank: Array.from(words).sort() };
}

/**
 * Validate a word against the bank.
 */
export function validateWord(word: string, bank: string[]): boolean {
  return bank.includes(word.toLowerCase().trim());
}

/**
 * Calculate score for a word in Scrabble.
 * Base 100 per word. Uniqueness bonus = 500 if no other submission contains this word.
 */
export function calculateScore(
  words: string[],
  bank: string[],
  allSubmissions: Array<{ words: string[] }>
): { points: number; uniquenessBonus: number; wordDetails: Array<{ word: string; base: number; unique: boolean }> } {
  const uniqueWords = new Set(words.map((w) => w.toLowerCase().trim()));
  let totalPoints = 0;
  let totalBonus = 0;
  const wordDetails: Array<{ word: string; base: number; unique: boolean }> = [];

  for (const w of uniqueWords) {
    if (!validateWord(w, bank)) continue;
    const isUnique = !allSubmissions.some(
      (s) => s.words.some((sw) => sw.toLowerCase().trim() === w)
    );
    const base = 100;
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
  const result = calculateScore(submission.words, roundData.bank, allSubmissions);
  return result.points;
}