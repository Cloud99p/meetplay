/**
 * Server-side copy of the resumed-turn merge rule that lives in
 * `src/lib/stt/captionRows.ts` (`continuedTurn`).
 *
 * WHY A COPY: the frontend and the server are two separate TypeScript
 * projects — the frontend compiles `src/` with no `rootDir`, the server
 * compiles `server/src` with `rootDir: "server/src"`. A file shared by both
 * would have to break one of those (adding it to the server's include puts it
 * outside rootDir and moves the build output). So the rule is duplicated
 * DELIBERATELY, with the client copy as the source of truth, and
 * `npm run verify:transcript` feeds both copies the same fixtures — it fails if
 * their join decisions ever disagree, so they cannot drift silently.
 *
 * WHAT IT IS FOR (read-time TEXT only, never a counter):
 *   - The persisted transcript. `transcript_events` rows hold the COUNTABLE
 *     payload — on a resumed Flux turn that is only the new tail words
 *     ("it friday") — plus `turn_text`/`turn_seq` for provenance.
 *     `mergeTurnRows()` puts each turn's sentence back together before the
 *     recap page and its .txt download render it.
 *   - Quote surfaces: quiz "Who said this?" and Who Said That. They pick from
 *     the in-memory utterance buffer (which holds the tail), so
 *     `resolveTurnText()` spells out the whole turn instead of the fragment.
 *
 * WHAT IT MUST NEVER TOUCH: word accounting. Market/flash/user-market counts,
 * bingo marks, speaker stats and the quiz's `wordFrequencies()` all read the
 * countable `text`; handing any of them a joined turn would count the shared
 * prefix of a resumed turn twice.
 */

/** A caption/utterance fragment that may carry its turn's identity. */
export interface TurnFragment {
  speakerId: string;
  /** The countable payload — on a resumed turn, only the new tail words. */
  text: string;
  /** The full text of the turn, when it differs from `text`. */
  turnText?: string;
  /** Identity of the turn; see Utterance.turnSeq. */
  turnSeq?: number;
}

/** Same normalisation the adapter and the client rule use, so all three agree. */
export function normalizeTurnText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The turn's wording for a fragment: the full text when it has one. */
function turnTextOf(fragment: TurnFragment): string {
  return (fragment.turnText ?? fragment.text).trim();
}

/**
 * Does `cur` continue the sentence `last` is showing? Returns the text to render
 * if it does, otherwise null. Copied verbatim from `src/lib/stt/captionRows.ts`
 * — read the long-form rationale there; the short version:
 *
 *   - one sentence, emitted twice: an eager final ("we should ship") then a
 *     refined final carrying only the new tail words ("it friday");
 *   - two sentences where the second opens with the first ("we should ship",
 *     then a new turn: "we should ship it friday").
 *
 * Text alone cannot tell them apart, so nothing here merges on text alone. Both
 * emissions must carry the SAME `turnSeq` for the same speaker, the row's words
 * must stay a prefix of the incoming turn text, and this caption's own words
 * must be the tail of it. Anything else returns null and the caller keeps two
 * rows: mis-rendering two lines is recoverable, a swallowed word is not.
 */
export function continuedTurn<T extends TurnFragment>(last: T, cur: T): string | null {
  if (cur.turnSeq === undefined || cur.turnSeq !== last.turnSeq) return null;
  if (cur.speakerId !== last.speakerId) return null;
  // Absent identity is NOT the same identity: two rows whose speaker was lost in
  // a mapping would otherwise compare equal and join two people's sentences.
  // Kept in sync with the client copy; see the note in src/lib/stt/captionRows.ts.
  if (!last.speakerId || !cur.speakerId) return null;
  const lastT = normalizeTurnText(last.turnText ?? last.text);
  const curT = normalizeTurnText(cur.turnText ?? cur.text);
  const curText = normalizeTurnText(cur.text);
  if (!lastT || !curT || !curText) return null;
  // The row is covered...
  if (!curT.startsWith(lastT)) return null;
  // ...and this caption is accounted for inside the turn text. Note it is NOT
  // `lastT + ' ' + curText`: the adapter diffs a tail against the previous
  // FINAL, while an earlier fragment may already have grown this row past it.
  if (curT !== curText && !curT.endsWith(` ${curText}`)) return null;
  return (cur.turnText ?? cur.text).trim();
}

/**
 * Join each turn's fragments into one row, for the persisted transcript.
 *
 * Grouping is by turn IDENTITY (speaker + turnSeq), not by position: a resumed
 * turn's tail can land seconds after its eager half, with another participant's
 * words in between, and the recap must still read one sentence. `turnSeq` is
 * unique per turn for one adapter session, so a group is one sentence; where
 * that assumption is wrong the rule's verification simply refuses the join.
 *
 * The merged row keeps the LAST fragment's identity and timestamp (the moment
 * the sentence finished) and renders the joined text. A turn the rule never joined
 * — a lone fragment, or one whose later fragment is a rewrite — keeps its own
 * counted `text`, exactly as the live caption display renders the same rows, so
 * the two surfaces cannot disagree. Rows without a turnSeq — every adapter that
 * never re-emits a turn, and every row written before this existed — pass through
 * untouched too.
 */
export function mergeTurnRows<T extends TurnFragment>(rows: T[]): T[] {
  const groups = new Map<string, number[]>();
  rows.forEach((row, i) => {
    if (row.turnSeq === undefined) return;
    const key = `${row.speakerId}#${row.turnSeq}`;
    const group = groups.get(key);
    if (group) group.push(i);
    else groups.set(key, [i]);
  });

  const out = rows.slice();
  const absorbed = new Set<number>();

  for (const indexes of groups.values()) {
    // Fold in EMISSION order — which, for a turn that only ever grows, is the
    // order of increasing turn text (each final restates at least what came
    // before). Deliberately NOT the order the rows came back in: Postgres does
    // not order rows that share a `created_at`, and the two halves of a resumed
    // turn can land in the same millisecond — a tie must not be able to lose the
    // join. Sorting by length cannot join the wrong thing either, because
    // continuedTurn still verifies every single step.
    const ordered = [...indexes].sort(
      (a, b) =>
        normalizeTurnText(turnTextOf(rows[a])).length -
        normalizeTurnText(turnTextOf(rows[b])).length
    );
    let current = ordered[0];
    let text = turnTextOf(rows[current]);
    let joined = false;
    for (const i of ordered) {
      if (i === current) continue;
      const continued = continuedTurn({ ...rows[current], text, turnText: text }, rows[i]);
      if (continued === null) {
        if (joined) out[current] = { ...rows[current], text };
        current = i;
        text = turnTextOf(rows[i]);
        joined = false;
        continue;
      }
      absorbed.add(current);
      current = i;
      text = continued;
      joined = true;
    }
    if (joined) out[current] = { ...rows[current], text };
  }

  return out.filter((_, i) => !absorbed.has(i));
}

/**
 * The fullest VERIFIED wording of the turn `utterance` belongs to, drawn from
 * `pool` (the utterance buffer / graph quotes a game is quoting from).
 *
 * Every candidate is tested with `continuedTurn`, so a fragment that does not
 * continue this turn — a rewrite, or a new turn that merely opens with the same
 * words — is ignored. With no turn identity the utterance's own wording is
 * returned unchanged, which is what every adapter that never re-emits a turn
 * relies on.
 */
export function resolveTurnText<T extends TurnFragment>(pool: T[], utterance: T): string {
  let text = turnTextOf(utterance);
  if (utterance.turnSeq === undefined) return text;
  for (const other of pool) {
    if (other === utterance) continue;
    if (other.speakerId !== utterance.speakerId || other.turnSeq !== utterance.turnSeq) continue;
    const joined = continuedTurn({ ...utterance, text, turnText: text }, other);
    if (joined !== null) text = joined;
  }
  return text;
}
