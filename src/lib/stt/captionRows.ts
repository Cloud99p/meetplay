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
 *
 * Resumed Flux turns take the other route into the same bug: the adapter emits
 * the eager final in full, then the refined final as the NEW TAIL ONLY, so
 * "we should ship" and "it friday" are two entries for one sentence. Those are
 * joined here using the turn identity the adapter stamps on each emission
 * (turnSeq/turnText) — never by guessing from the words.
 */

export interface CaptionLike {
  speakerId: string;
  speakerName: string | null;
  text: string;
  isFinal: boolean;
  confidence?: number;
  /**
   * Full text of the turn this caption belongs to, when it differs from `text`
   * (see Utterance.turnText). Optional: adapters that never re-emit a turn do
   * not send it, and this function works exactly as before without it.
   */
  turnText?: string;
  /**
   * Identity of the turn this caption belongs to (see Utterance.turnSeq).
   * Two captions sharing a turnSeq for one speaker are one growing sentence;
   * different turnSeqs are different sentences.
   */
  turnSeq?: number;
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

/**
 * Does `cur` continue the sentence `last` is showing? Returns the text to render
 * if it does, otherwise null.
 *
 * This is the only merge allowed to replace an already-settled row, and it is
 * VERIFIED rather than inferred, because the two ways a caption stream can
 * repeat itself are otherwise indistinguishable:
 *
 *   - one sentence, emitted twice: an eager final ("we should ship") then a
 *     refined final carrying only the new tail words ("it friday");
 *   - two sentences where the second opens with the first ("we should ship",
 *     then a new turn: "we should ship it friday").
 *
 * Text alone cannot tell them apart, so nothing here merges on text alone. Both
 * emissions must carry the SAME `turnSeq` for the same speaker (a new turn can
 * never be swallowed), and the incoming caption must ACCOUNT for the row it
 * would replace:
 *
 *   - the row's words stay a prefix of the incoming turn text (`startsWith`), so
 *     replacing the row cannot drop what it showed; and
 *   - the incoming caption's own words are the tail of that turn text
 *     (`endsWith`, or the caption IS the whole turn text), so its payload is
 *     not dropped either — and it is not a rewritten sentence arriving mid-turn.
 *
 * Anything else returns null and the caller appends, which is always safe:
 * mis-rendering two lines is recoverable, a swallowed word is not.
 */
function continuedTurn(last: CaptionLike, cur: CaptionLike): string | null {
  if (cur.turnSeq === undefined || cur.turnSeq !== last.turnSeq) return null;
  if (cur.speakerId !== last.speakerId) return null;
  // Absent identity is NOT the same identity: two rows whose speaker was lost in
  // a mapping would otherwise compare equal and join two people's sentences.
  // Kept in sync with the server copy in server/src/stt/turnText.ts, which
  // `npm run verify:transcript` runs against these same fixtures.
  if (!last.speakerId || !cur.speakerId) return null;
  const lastT = normalize(last.turnText ?? last.text);
  const curT = normalize(cur.turnText ?? cur.text);
  const curText = normalize(cur.text);
  if (!lastT || !curT || !curText) return null;
  // The row is covered...
  if (!curT.startsWith(lastT)) return null;
  // ...and this caption is accounted for inside the turn text. Note it is NOT
  // `lastT + ' ' + curText`: the adapter diffs a tail against the previous
  // FINAL, while an interim may already have grown this row past it.
  if (curT !== curText && !curT.endsWith(` ${curText}`)) return null;
  return (cur.turnText ?? cur.text).trim();
}

export function collapseCaptions<T extends CaptionLike>(captions: T[]): CaptionRow[] {
  const out: CaptionRow[] = [];

  for (const c of captions) {
    const text = c.text.trim();
    if (!text) continue;

    const last = out[out.length - 1];

    if (last) {
      // Same turn, and the incoming caption accounts for what the row already
      // shows: grow that row (a resumed turn's tail, or an interim re-stating
      // the turn). Checked first because it is the only rule that may replace a
      // settled row, and it leaves no room for the loss the later rules avoid.
      const continued = continuedTurn(last, c);
      if (continued !== null) {
        out[out.length - 1] = {
          ...last,
          text: continued,
          turnText: continued,
          isFinal: c.isFinal,
          live: !c.isFinal,
          confidence: c.confidence ?? last.confidence,
          timestamp: c.timestamp,
        };
        continue;
      }

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
