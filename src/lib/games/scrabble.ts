export interface ScrabbleQuestion {
  bank: string[];
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