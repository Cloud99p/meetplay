/**
 * Collapses a caption stream into display rows.
 *
 * Why this exists: the STT engine narrates one sentence several times. Take a
 * single spoken sentence on the v2 Flux path:
 *
 *   StartOfTurn -> Update("hello") -> Update("hello there")
 *               -> EagerEndOfTurn("hello there") -> EndOfTurn("hello there")
 *
 * The adapter emits an interim for each Update and a final for the end-of-turn,
 * and the client appends every one of them to `captions` (it is a raw append
 * log: `prev.slice(-60)`). So one sentence becomes three overlapping entries,
 * and any surface that shows a window of that array renders the same words
 * stacked up - the "3 duplicates" bug.
 *
 * IMPORTANT: this is a DISPLAY transform. It never writes back to `captions`;
 * games and the recap keep reading the raw array, so a bug in this function can
 * only ever mis-render, never silently drop a word from scoring.
 */

export interface CaptionLike {
  speakerId: string;
  speakerName: string | null;
  text: string;
  isFinal: boolean;
  confidence?: number;
  timestamp: number;
}

export interface CaptionRow extends CaptionLike {
  /** Stable React key for the row. */
  key: string;
  /** True while the engine may still refine this text. */
  live: boolean;
}

/** Same normalisation the adapter uses to compare turns, so the two agree. */
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Interim results are not attributable, so the two code paths disagree with
 * their own finals about who is speaking: the v1 diarized path emits interims
 * as `unknown` and finals as `speaker-N`, while the v2 Flux path uses `local`
 * for both. A trailing interim is only allowed to be superseded by a *different*
 * speaker id when it matches this known interim identity.
 */
const INTERIM_ONLY_SPEAKERS = new Set(['unknown', 'local']);

export function collapseCaptions<T extends CaptionLike>(captions: T[]): CaptionRow[] {
  const out: CaptionRow[] = [];

  for (const c of captions) {
    const text = c.text.trim();
    if (!text) continue;

    const last = out[out.length - 1];

    if (last) {
      const lastN = normalize(last.text);
      const curN = normalize(text);
      const overlaps =
        lastN.length > 0 && curN.length > 0 && (curN.startsWith(lastN) || lastN.startsWith(curN));

      // A final settles the trailing live row only when it is genuinely the same
      // utterance: the texts have to overlap AND either the speaker matches or the
      // pending row is one of the unattributed interims that the v1 diarized path
      // re-labels at final time.
      //
      // Requiring the overlap matters. On a resumed turn the adapter emits only
      // the NEW TAIL words as the final (see emitFinalTurnText), so a same-speaker
      // final can be a continuation the user never sees again if we replace the
      // provisional line with it - "we should ship" would become "it friday".
      //
      // Never swallow a pending line just because the speaker matches: if the text
      // does not overlap, append, so nothing is ever lost from the display.
      const sameUtterance =
        overlaps && (last.speakerId === c.speakerId || INTERIM_ONLY_SPEAKERS.has(last.speakerId));

      if (c.isFinal && last.live && sameUtterance) {
        // Supersede: the final is the authoritative wording, so the provisional
        // row is replaced rather than kept alongside it.
        out[out.length - 1] = { ...last, ...c, key: last.key, text, live: false };
        continue;
      }

      // Refinement of the pending line: replace the text, keep one row.
      if (!c.isFinal && last.live && c.speakerId === last.speakerId) {
        out[out.length - 1] = { ...last, ...c, key: last.key, text };
        continue;
      }

      // The same settled sentence arriving twice (an eager final followed by an
      // identical refined final): keep one row.
      if (c.isFinal && !last.live && c.speakerId === last.speakerId && lastN === curN) continue;
    }

    out.push({
      ...c,
      text,
      key: `${c.timestamp}-${out.length}-${c.speakerId}`,
      live: !c.isFinal,
    });
  }

  return out;
}
