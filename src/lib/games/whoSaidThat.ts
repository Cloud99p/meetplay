export interface WhoSaidThatQuestion {
  quote: string;
  speakerId: string;
  options: Array<{ id: string; name: string }>;
}

export function isWhoSaidThatQuestion(data: unknown): data is WhoSaidThatQuestion {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return typeof d.quote === 'string' && typeof d.speakerId === 'string' && Array.isArray(d.options);
}

export function whoSaidThatSubmitAnswer(speakerId: string): { answer: string } {
  return { answer: speakerId };
}