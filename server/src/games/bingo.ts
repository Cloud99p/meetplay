// Buzzword Bingo — passive, auto-marked from the live transcript.
//
// Every participant gets a deterministic 5×5 card (seeded by roomId +
// participantId + round number, so it survives reconnects and matches the
// client's locally-rendered card exactly). The server marks words as they
// are spoken and broadcasts marks privately to each participant; the first
// line (row/col/diag) wins the round.

export const BINGO_SIZE = 5;
export const BINGO_CARD_WORDS = 25;

/** The meeting-jargon pool cards are dealt from. */
export const BINGO_WORDS: string[] = [
  'synergy', 'action item', 'circle back', 'touch base', 'roadmap',
  'deadline', 'asap', 'follow up', 'agenda', 'stakeholder',
  'leverage', 'bandwidth', 'pivot', 'onboarding', 'alignment',
  'deliverable', 'kpi', 'status update', 'next steps', 'blocker',
  'loop in', 'sidebar', 'parking lot', 'deep dive', 'high level',
  'win-win', 'ballpark', 'quarter', 'sync', 'deck',
  'feedback', 'metrics', 'milestone', 'priority', 'ownership',
  'transparency', 'streamline', 'optimize', 'scalable', 'sprint',
  'backlog', 'standup', 'retro', 'scope', 'budget',
  'timeline', 'eta', 'actionable', 'proactive', 'collaborate',
  'disconnect', 'reconnect', 'mute', 'unmute', 'camera',
  'recording', 'screen share', 'zoom out', 'ping', 'tl;dr',
];

/** Deterministic string hash — MUST stay in sync with src/lib/games/bingo.ts */
export function hashString(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** Small fast PRNG — MUST stay in sync with src/lib/games/bingo.ts */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 25-word card for a participant in a given round. */
export function buildBingoCard(roomId: string, participantId: string, roundNumber: number): string[] {
  const rng = mulberry32(hashString(`${roomId}:${participantId}:${roundNumber}`));
  const pool = [...BINGO_WORDS];
  // Fisher-Yates
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, BINGO_CARD_WORDS);
}

/** Does the utterance text contain this card word/phrase? */
export function cardWordMatches(text: string, word: string): boolean {
  const lower = text.toLowerCase();
  const w = word.toLowerCase();
  if (w.includes(' ')) {
    // phrase: match as a whole (word-boundary-ish)
    return lower.includes(w);
  }
  // single word: exact token match
  const tokens = lower.replace(/[^a-z0-9'-]/g, ' ').split(/\s+/).filter(Boolean);
  return tokens.includes(w);
}

/** Card indices (0–24) that match an utterance. */
export function matchingCardIndices(text: string, card: string[]): number[] {
  const hits: number[] = [];
  card.forEach((w, i) => {
    if (cardWordMatches(text, w)) hits.push(i);
  });
  return hits;
}

/** Detect a completed line (row / column / diagonal). */
export function findBingoLine(marks: Set<number>): { type: 'row' | 'col' | 'diag'; indices: number[] } | null {
  // rows
  for (let r = 0; r < BINGO_SIZE; r++) {
    const line = Array.from({ length: BINGO_SIZE }, (_, c) => r * BINGO_SIZE + c);
    if (line.every((i) => marks.has(i))) return { type: 'row', indices: line };
  }
  // columns
  for (let c = 0; c < BINGO_SIZE; c++) {
    const line = Array.from({ length: BINGO_SIZE }, (_, r) => r * BINGO_SIZE + c);
    if (line.every((i) => marks.has(i))) return { type: 'col', indices: line };
  }
  // diagonals
  const d1 = Array.from({ length: BINGO_SIZE }, (_, i) => i * BINGO_SIZE + i);
  if (d1.every((i) => marks.has(i))) return { type: 'diag', indices: d1 };
  const d2 = Array.from({ length: BINGO_SIZE }, (_, i) => i * BINGO_SIZE + (BINGO_SIZE - 1 - i));
  if (d2.every((i) => marks.has(i))) return { type: 'diag', indices: d2 };
  return null;
}
