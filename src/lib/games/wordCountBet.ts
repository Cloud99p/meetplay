export interface WordCountBetQuestion {
  targetWord: string;
  initialCount: number;
  actualCount?: number;
}

export function isWordCountBetQuestion(data: unknown): data is WordCountBetQuestion {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return typeof d.targetWord === 'string' && typeof d.initialCount === 'number';
}

export function wordCountBetSubmitAnswer(guess: number): { guess: number } {
  return { guess };
}