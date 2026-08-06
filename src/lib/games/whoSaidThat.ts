// Client-side Who Said That logic — mirrors server/src/games/whoSaidThat.ts +
// qualityGate.ts quality checks (optimistic preview; server is authoritative).

export interface UtteranceLike {
  speakerId: string;
  text: string;
  timestamp: number;
}

export interface ParticipantBrief {
  id: string;
  name: string;
}

export interface WhoSaidThatQuestion {
  quote: string;
  speakerId: string;
  options: Array<{ id: string; name: string }>;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that',
  'these', 'those', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'me', 'him', 'us', 'them', 'not', 'no', 'nor', 'so', 'very', 'too',
  'just', 'about', 'up', 'down', 'out', 'off', 'over', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same', 'as', 'than', 'if', 'because',
  'while', 'what', 'which', 'who', 'whom', 'whose', 'ok', 'yeah', 'hi',
  'hello', 'hey', 'like', 'well', 'right', 'actually', 'basically',
  'literally', 'really', 'pretty', 'quite', 'anyway', 'okay', 'oh',
  'ah', 'um', 'uh', 'hmm', 'got', 'get', 'let', 'going', 'gonna',
]);

/** Quality gate — same rules as server/src/games/qualityGate.ts. */
export function qualityCheck(
  utterance: UtteranceLike,
  transcripts: UtteranceLike[]
): { pass: boolean; reason?: string } {
  const words = utterance.text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length < 10) {
    return { pass: false, reason: 'Too short (less than 10 words)' };
  }

  const overlapping = transcripts.filter(
    (u) => u.timestamp === utterance.timestamp && u.speakerId !== utterance.speakerId
  );
  if (overlapping.length > 0) {
    return { pass: false, reason: 'Ambiguous — overlaps with another speaker' };
  }

  const contentWords = words.filter((w) => !STOPWORDS.has(w) && w.length > 2);
  if (contentWords.length < 3) {
    return { pass: false, reason: 'Too many stopwords, not enough meaningful content' };
  }

  return { pass: true };
}

/** Select a random quality-passing quote + 4 options (1 correct + 3 decoys). */
export function selectRandomQuote(
  utterances: UtteranceLike[],
  participants: ParticipantBrief[]
): WhoSaidThatQuestion | null {
  const valid = utterances.filter((u) => qualityCheck(u, utterances).pass);
  if (valid.length === 0) return null;

  const pick = valid[Math.floor(Math.random() * valid.length)];
  const correctSpeaker = participants.find((p) => p.id === pick.speakerId);
  if (!correctSpeaker) return null;

  const decoys = participants
    .filter((p) => p.id !== pick.speakerId)
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);

  const options = [
    { id: correctSpeaker.id, name: correctSpeaker.name },
    ...decoys.map((p) => ({ id: p.id, name: p.name })),
  ].sort(() => Math.random() - 0.5);

  return { quote: pick.text, speakerId: pick.speakerId, options };
}

/**
 * Score a submission — speed bonus: faster = more points, max 1000.
 * Mirrors server scoreWhoSaidThat: 500 + 500 * (timeRemainingMs / timeLimitMs).
 */
export function scoreSubmission(
  timeMs: number,          // time taken to answer
  correct: boolean,
  timeLimitMs: number      // total round time limit
): number {
  if (!correct) return 0;
  const remaining = Math.max(0, timeLimitMs - timeMs);
  const fraction = Math.max(0, remaining / timeLimitMs);
  return Math.round(500 + 500 * fraction);
}

export function isWhoSaidThatQuestion(data: unknown): data is WhoSaidThatQuestion {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return typeof d.quote === 'string' && typeof d.speakerId === 'string' && Array.isArray(d.options);
}

export function whoSaidThatSubmitAnswer(speakerId: string): { answer: string } {
  return { answer: speakerId };
}
