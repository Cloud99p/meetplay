// Passive engagement stats — Um-O-Meter + share of voice.
//
// Tracked per speaker from the live transcript. No interaction required;
// the data just appears in the stats panel as the call progresses.

export interface SpeakerStats {
  words: number;
  utterances: number;
  fillers: number;
}

export interface SpeakerStatRow extends SpeakerStats {
  participantId: string;
  participantName: string;
  shareOfVoice: number; // 0–100
}

/** Filler words counted by the Um-O-Meter (single tokens + phrases). */
const FILLER_SINGLES = new Set([
  'um', 'uh', 'er', 'hmm', 'like', 'well', 'actually', 'basically',
  'literally', 'right', 'okay', 'so', 'kinda', 'sorta', 'yeah', 'yep',
  'ugh',
]);

const FILLER_PHRASES = ['you know', 'i mean', 'kind of', 'sort of', 'at the end of the day', 'to be honest'];

export function countFillers(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const p of FILLER_PHRASES) {
    let idx = lower.indexOf(p);
    while (idx !== -1) {
      count++;
      idx = lower.indexOf(p, idx + p.length);
    }
  }
  const tokens = lower.replace(/[^a-z0-9'-]/g, ' ').split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (FILLER_SINGLES.has(t)) count++;
  }
  return count;
}

export function countWords(text: string): number {
  return text.replace(/[^a-z0-9'-]/g, ' ').split(/\s+/).filter(Boolean).length;
}

/** Merge an utterance into the running per-speaker stats. */
export function updateSpeakerStats(
  stats: Map<string, SpeakerStats>,
  speakerId: string,
  text: string
): void {
  const cur = stats.get(speakerId) ?? { words: 0, utterances: 0, fillers: 0 };
  cur.utterances += 1;
  cur.words += countWords(text);
  cur.fillers += countFillers(text);
  stats.set(speakerId, cur);
}

/** Build broadcast rows with names resolved and share-of-voice computed. */
export function buildStatRows(
  stats: Map<string, SpeakerStats>,
  nameById: Map<string, string>
): SpeakerStatRow[] {
  const totalWords = Array.from(stats.values()).reduce((a, s) => a + s.words, 0);
  const rows: SpeakerStatRow[] = [];
  for (const [id, s] of stats) {
    rows.push({
      participantId: id,
      participantName: nameById.get(id) ?? 'Unknown',
      words: s.words,
      utterances: s.utterances,
      fillers: s.fillers,
      shareOfVoice: totalWords > 0 ? Math.round((s.words / totalWords) * 1000) / 10 : 0,
    });
  }
  rows.sort((a, b) => b.words - a.words);
  return rows;
}
