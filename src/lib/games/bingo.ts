// Client-side Buzzword Bingo — mirrors server/src/games/bingo.ts exactly so
// the locally-rendered card matches the server's (seeded by roomId +
// participantId + roundNumber).

export const BINGO_SIZE = 5;

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

export function buildBingoCard(roomId: string, participantId: string, roundNumber: number): string[] {
  const rng = mulberry32(hashString(`${roomId}:${participantId}:${roundNumber}`));
  const pool = [...BINGO_WORDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, BINGO_SIZE * BINGO_SIZE);
}

export interface BingoSate {
  roundId: string;
  roundNumber: number;
  myCard: string[];
  myMarks: number[];
  winner: { participantId: string; participantName: string } | null;
}
