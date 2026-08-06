// Client-side Meeting Scrabble logic — mirrors server/src/games/scrabble.ts
// (optimistic preview; server is authoritative).

export interface UtteranceLike {
  speakerId: string;
  text: string;
  timestamp: number;
}

export interface ScrabbleQuestion {
  bank: string[];
}

const MIN_WORD_LENGTH = 2;

/** Build a word bank from utterances — unique words, lowercase, deduped, sorted. */
export function buildWordBank(utterances: UtteranceLike[]): string[] {
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
  return Array.from(words).sort();
}

/** A word is valid if it is in the bank and at least 2 chars. */
export function validateWord(word: string, bank: string[]): boolean {
  const w = word.toLowerCase().trim();
  return w.length >= MIN_WORD_LENGTH && bank.includes(w);
}

/**
 * Score a submission: 100 base per valid word + 500 uniqueness bonus
 * if no other submission played that word. Mirrors server calculateScore.
 */
export function calculateScore(
  words: string[],
  bank: string[],
  allSubmissions: Array<{ words: string[] }>
): { points: number; uniquenessBonus: number } {
  const uniqueWords = new Set(words.map((w) => w.toLowerCase().trim()));
  let totalPoints = 0;
  let totalBonus = 0;

  for (const w of uniqueWords) {
    if (!validateWord(w, bank)) continue;
    const isUnique = !allSubmissions.some(
      (s) => s.words.some((sw) => sw.toLowerCase().trim() === w)
    );
    const bonus = isUnique ? 500 : 0;
    totalPoints += 100 + bonus;
    totalBonus += bonus;
  }

  return { points: totalPoints, uniquenessBonus: totalBonus };
}

export function isScrabbleQuestion(data: unknown): data is ScrabbleQuestion {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return Array.isArray(d.bank);
}

export function scrabbleSubmitAnswer(words: string[]): { words: string[] } {
  return { words };
}

export function filterValidScrabbleWords(words: string[], bank: string[]): string[] {
  const lowerBank = new Set(bank.map((w) => w.toLowerCase()));
  return words.filter((w) => lowerBank.has(w.toLowerCase().trim()));
}
