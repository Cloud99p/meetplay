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

export interface UtteranceInfo {
  speakerId: string;
  text: string;
  timestamp: number;
}

export function validateQuote(
  utterance: UtteranceInfo,
  roomBuffer: UtteranceInfo[]
): { pass: boolean; reason?: string } {
  const words = utterance.text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length < 10) {
    return { pass: false, reason: 'Too short (less than 10 words)' };
  }

  // Check for overlap — utterances with the same timestamp from different speakers
  const overlapping = roomBuffer.filter(
    (u) => u.timestamp === utterance.timestamp && u.speakerId !== utterance.speakerId
  );
  if (overlapping.length > 0) {
    return { pass: false, reason: 'Ambiguous — overlaps with another speaker' };
  }

  // Check for trivial content: must have at least 3 non-stopword content words
  const contentWords = words.filter((w) => !STOPWORDS.has(w) && w.length > 2);
  if (contentWords.length < 3) {
    return { pass: false, reason: 'Too many stopwords, not enough meaningful content' };
  }

  return { pass: true };
}