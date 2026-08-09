// Client-side Letter Tiles logic — mirrors server/src/games/scrabble.ts
// (optimistic preview; server is authoritative).

export interface UtteranceLike {
  speakerId: string;
  text: string;
  timestamp: number;
}

export interface ScrabbleQuestion {
  bank: string[];
  /** Shuffled letter tiles (duplicates possible) — the player's board. */
  pool: string[];
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
 * Score a submission: length-based points per valid word (in bank AND
 * spellable from pool) + 500 uniqueness bonus per word no one else played.
 */
export function calculateScore(
  words: string[],
  bank: string[],
  pool: string[],
  allSubmissions: Array<{ words: string[] }>
): { points: number; uniquenessBonus: number } {
  const uniqueWords = new Set(words.map((w) => w.toLowerCase().trim()));
  let totalPoints = 0;
  let totalBonus = 0;

  for (const w of uniqueWords) {
    if (!validateWord(w, bank) || !canFormWord(w, pool)) continue;
    const isUnique = !allSubmissions.some(
      (s) => s.words.some((sw) => sw.toLowerCase().trim() === w)
    );
    const bonus = isUnique ? 500 : 0;
    totalPoints += wordPoints(w) + bonus;
    totalBonus += bonus;
  }

  return { points: totalPoints, uniquenessBonus: totalBonus };
}

export function isScrabbleQuestion(data: unknown): data is ScrabbleQuestion {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return Array.isArray(d.bank) && Array.isArray(d.pool);
}

export function scrabbleSubmitAnswer(words: string[]): { words: string[] } {
  return { words };
}

export function filterValidScrabbleWords(words: string[], bank: string[], pool: string[]): string[] {
  const lowerBank = new Set(bank.map((w) => w.toLowerCase()));
  return words.filter(
    (w) => lowerBank.has(w.toLowerCase().trim()) && canFormWord(w, pool)
  );
}
