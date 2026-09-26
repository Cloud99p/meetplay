/**
 * Verifies the on-screen captions: the three display modes (visible /
 * transparent / hidden), and that duplicate narration of one sentence is
 * collapsed before it is drawn.
 *
 * These are the two things Cloud reported from a live call:
 *   "its still 3 duplicates"                        -> the collapse cases below
 *   "the toggle ... only make the transcripts in the
 *    middle of the screen visible or transparent"   -> the mode cases below
 *
 * It also covers the two surfaces that read the SAME resumed turn from outside
 * the live caption array, and which needed the turn identity persisted/available
 * there (see server/src/stt/turnText.ts):
 *   - the persisted transcript (`transcript_events` -> recap page -> .txt
 *     download), which must render one sentence as one line;
 *   - the game quote surfaces (Who Said That, the recap quiz's "who said this"),
 *     which must quote the whole turn rather than the tail fragment.
 * Both keep every counter on the countable `text`, which the last section
 * pins down.
 *
 * Note what is NOT here: no sidebar/panel is exercised, because opening one was
 * never the intent — the setting controls the caption text in the middle of the
 * screen.
 *
 * Usage (from the repo root):
 *   npm run verify:transcript
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import CaptionsOverlay, { resolveTranscriptMode, TRANSCRIPT_MODES } from '../src/components/meeting/Captions.tsx';
import { collapseCaptions } from '../src/lib/stt/captionRows.ts';
// The server's copy of the same rule, plus the two game surfaces that quote from
// the utterance buffer. Imported from the server tree on purpose: that is where
// the recap transcript and the quotes are actually built, and running BOTH
// copies here is what stops them drifting apart.
import { mergeTurnRows, resolveTurnText } from '../server/src/stt/turnText.ts';
import { buildQuizQuestions } from '../server/src/games/quiz.ts';
import { makeWhoSaidThatRound } from '../server/src/games/whoSaidThat.ts';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const count = (haystack, needle) => haystack.split(needle).length - 1;

const cap = (over = {}) => ({
  speakerId: 'a',
  speakerName: 'Ada',
  text: 'hello',
  isFinal: true,
  confidence: 0.9,
  timestamp: 1000,
  ...over,
});

const render = (captions, mode = 'visible') =>
  renderToStaticMarkup(createElement(CaptionsOverlay, { captions, mode }));

console.log('--- collapseCaptions (the duplicate-words bug) ---');

// The exact sequence Cloud is hearing: one sentence, three emissions.
const flux = collapseCaptions([
  cap({ speakerId: 'local', text: 'hello', isFinal: false, timestamp: 1 }),
  cap({ speakerId: 'local', text: 'hello there', isFinal: false, timestamp: 2 }),
  cap({ speakerId: 'local', text: 'hello there', isFinal: true, timestamp: 3 }),
]);
check('Flux: one sentence -> one row', flux.length === 1, `rows=${flux.length}`);
check('Flux: row holds the settled text', flux[0]?.text === 'hello there');
check('Flux: nothing left marked live', flux[0]?.live === false);

// The v1 diarized path disagrees with itself about the speaker of a sentence:
// interims are unattributed, finals are `speaker-N`.
const v1 = collapseCaptions([
  cap({ speakerId: 'unknown', speakerName: null, text: 'we should ship', isFinal: false, timestamp: 1 }),
  cap({ speakerId: 'speaker-0', speakerName: 'Ada', text: 'we should ship it friday', isFinal: true, timestamp: 2 }),
]);
check('v1: unattributed interim + diarized final -> one row', v1.length === 1, `rows=${v1.length}`);
check('v1: final wording wins', v1[0]?.text === 'we should ship it friday');

// SAFETY: a pending line must never be swallowed by a different speaker.
const twoSpeakers = collapseCaptions([
  cap({ speakerId: 'speaker-0', speakerName: 'Ada', text: 'yes', isFinal: false, timestamp: 1 }),
  cap({ speakerId: 'speaker-1', speakerName: 'Bo', text: 'yes we can', isFinal: true, timestamp: 2 }),
]);
check('a different speaker does not eat the pending line', twoSpeakers.length === 2, `rows=${twoSpeakers.length}`);

// SAFETY: on a resumed turn the adapter sends only the TAIL words, so a final
// that does not continue the pending line must APPEND, never replace it —
// otherwise "we should ship" + "it friday" would render as just "it friday".
const tail = collapseCaptions([
  cap({ speakerId: 'local', text: 'we should ship', isFinal: false, timestamp: 1 }),
  cap({ speakerId: 'local', text: 'it friday', isFinal: true, timestamp: 2 }),
]);
check('tail-only final appends instead of replacing', tail.length === 2, `rows=${tail.length}`);
check('both halves survive', tail[0]?.text === 'we should ship' && tail[1]?.text === 'it friday');

// The resumed turn, as the adapter really emits it: same turn (turnSeq), and the
// turn's FULL text riding along on both finals as `turnText`. That is the fact
// display needs to join the sentence instead of stacking the halves.
const resumed = collapseCaptions([
  cap({ speakerId: 'local', text: 'we should ship', turnText: 'we should ship', turnSeq: 7, isFinal: false, timestamp: 1 }),
  cap({ speakerId: 'local', text: 'we should ship', turnText: 'we should ship', turnSeq: 7, isFinal: true, timestamp: 2 }),
  cap({ speakerId: 'local', text: 'it friday', turnText: 'we should ship it friday', turnSeq: 7, isFinal: true, timestamp: 3 }),
]);
check('resumed turn: one row for the sentence', resumed.length === 1, `rows=${resumed.length}`);
check('resumed turn: the row reads the whole sentence', resumed[0]?.text === 'we should ship it friday', `text=${resumed[0]?.text}`);
check(
  'resumed turn: no words dropped',
  /we should ship/.test(resumed[0]?.text ?? '') && /it friday/.test(resumed[0]?.text ?? '')
);

// SAFETY: the same opening words in a NEW turn (a different turnSeq) are a
// separate sentence. Merging there would hide that it was said twice.
check('a new turn never merges into the previous line', collapseCaptions([
  cap({ speakerId: 'local', text: 'we should ship', turnText: 'we should ship', turnSeq: 7, timestamp: 1 }),
  cap({ speakerId: 'local', text: 'we should ship it friday', turnText: 'we should ship it friday', turnSeq: 8, timestamp: 2 }),
]).length === 2);

// SAFETY: same turn, but the caption does not account for the row (a rewrite).
// Appending keeps the old row, so a replacement can never drop its words.
check('a same-turn rewrite appends (nothing is swallowed)', collapseCaptions([
  cap({ speakerId: 'local', text: 'we should ship', turnText: 'we should ship', turnSeq: 7, timestamp: 1 }),
  cap({ speakerId: 'local', text: 'completely different', turnText: 'completely different', turnSeq: 7, timestamp: 2 }),
]).length === 2);

check('separate sentences are preserved', collapseCaptions([
  cap({ text: 'first one', timestamp: 1 }),
  cap({ text: 'second one', timestamp: 2 }),
]).length === 2);

check('interim refinement -> one row with the later text', (() => {
  const r = collapseCaptions([
    cap({ speakerId: 'a', text: 'so the', isFinal: false, timestamp: 1 }),
    cap({ speakerId: 'a', text: 'so the plan is', isFinal: false, timestamp: 2 }),
  ]);
  return r.length === 1 && r[0].text === 'so the plan is';
})());

check('identical repeated final -> one row', collapseCaptions([
  cap({ text: 'exactly the same', timestamp: 1 }),
  cap({ text: 'exactly the same', timestamp: 2 }),
]).length === 1);

check('empty input -> empty output', collapseCaptions([]).length === 0);
check('whitespace-only captions are dropped', collapseCaptions([cap({ text: '   ' })]).length === 0);

console.log('--- CaptionsOverlay modes (visible / hidden) ---');

// Two states, not three. The middle "transparent" setting was tried and removed.
check('there are exactly two modes', TRANSCRIPT_MODES.length === 2 && TRANSCRIPT_MODES.join() === 'visible,hidden', TRANSCRIPT_MODES.join());

const live = [cap({ text: 'a caption line' })];

check('hidden renders nothing', render(live, 'hidden') === '');

const solid = render(live, 'visible');
check('visible draws the caption', solid.includes('a caption line'));
check('visible uses the solid pill', solid.includes('bg-caption-bg'));
check('visible is not blurred', !solid.includes('backdrop-blur-sm'));

check('no captions -> nothing drawn even when visible', render([], 'visible') === '');

check('no see-through styling survives the retired mode', !solid.includes('bg-caption-bg/20'));

// The panel Cloud did not want must never come back.
check('no sidebar/panel is rendered in any mode', TRANSCRIPT_MODES.every((m) => {
  const html = render(live, m);
  return !html.includes('Transcript') && !html.includes('aria-label="Meeting transcript"');
}));

// A preference saved by the retired three-mode build must not strand anyone:
// `transparent` meant "show me captions", so it maps onto `visible`.
check('legacy transparent preference maps to visible', resolveTranscriptMode('transparent') === 'visible');
check('visible stays visible', resolveTranscriptMode('visible') === 'visible');
check('hidden stays hidden', resolveTranscriptMode('hidden') === 'hidden');
check('no stored preference -> hidden', resolveTranscriptMode(null) === 'hidden');
check('garbage -> hidden', resolveTranscriptMode('nonsense') === 'hidden');

// One sentence stays one line in the drawn output.
const dupes = render([
  cap({ speakerId: 'local', text: 'hello', isFinal: false, timestamp: 1 }),
  cap({ speakerId: 'local', text: 'hello there', isFinal: false, timestamp: 2 }),
  cap({ speakerId: 'local', text: 'hello there', isFinal: true, timestamp: 3 }),
]);
check(
  'drawn output does not repeat the sentence',
  count(dupes, 'hello there') === 1 && count(dupes, 'hello') === 1,
  `"hello there" x${count(dupes, 'hello there')}`
);

// ...and the resumed turn above reaches the drawn output joined up, which is the
// case Cloud actually reported ("we should ship" / "it friday" as two lines).
const resumedDrawn = render([
  cap({ speakerId: 'local', speakerName: 'Cloud', text: 'we should ship', turnText: 'we should ship', turnSeq: 7, isFinal: false, timestamp: 1 }),
  cap({ speakerId: 'local', speakerName: 'Cloud', text: 'it friday', turnText: 'we should ship it friday', turnSeq: 7, isFinal: true, timestamp: 2 }),
]);
check(
  'drawn output shows the resumed turn as one sentence',
  count(resumedDrawn, 'we should ship it friday') === 1,
  `whole-sentence renders=${count(resumedDrawn, 'we should ship it friday')}`
);

check('low-confidence line is dimmed', render([cap({ confidence: 0.2 })], 'visible').includes('opacity-50'));
check('confident line is not dimmed', !render([cap({ confidence: 0.95 })], 'visible').includes('opacity-50'));

console.log('--- the persisted transcript: a resumed turn is one recap line ---');

// The resumed turn as the adapter emits it — and therefore as the server now
// stores it: the eager final in full, then the refined final carrying ONLY the
// new tail words. `release` is repeated three times on purpose: if a counter ever
// reads the fuller wording as well as the tail, the count doubles where the eye
// can see it.
const EAGER_TEXT = 'release release release and the launch plan is ready';
const TAIL_TEXT = 'morning before the demo starts and then we can celebrate';
const TURN_TEXT = `${EAGER_TEXT} ${TAIL_TEXT}`;

// transcript_events rows, in the shape the DB backends hand to mergeTurnRows():
// the speaker identity arrives as `speakerId`. `text` is the countable payload;
// turn_text/turn_seq are the provenance the recap merges on (see
// server/src/db/migrate.ts).
const tRow = (over = {}) => ({
  id: 'r1',
  speakerId: 'p1',
  participantName: 'Cloud',
  text: EAGER_TEXT,
  turnText: EAGER_TEXT,
  turnSeq: 7,
  createdAt: '2026-09-25T10:00:00.000Z',
  ...over,
});
const eagerRow = tRow();
const tailRow = tRow({
  id: 'r2',
  text: TAIL_TEXT,
  turnText: TURN_TEXT,
  createdAt: '2026-09-25T10:00:05.000Z',
});

const mergedRecap = mergeTurnRows([eagerRow, tailRow]);
check('two rows of one resumed turn render as one transcript line', mergedRecap.length === 1, `rows=${mergedRecap.length}`);
check('the line reads the whole sentence', mergedRecap[0]?.text === TURN_TEXT, `text="${mergedRecap[0]?.text}"`);
check(
  'the line keeps the tail row identity (the moment the sentence finished)',
  mergedRecap[0]?.id === 'r2' && mergedRecap[0]?.createdAt === tailRow.createdAt,
  `id=${mergedRecap[0]?.id}`
);
check(
  'the shared prefix is not doubled in the recap text',
  count(mergedRecap[0]?.text ?? '', 'release') === 3,
  `"release" x${count(mergedRecap[0]?.text ?? '', 'release')}`
);

// SAFETY: the rule only ever joins the same turn of the same speaker.
check(
  'a different speaker never merges into the line',
  mergeTurnRows([eagerRow, { ...tailRow, speakerId: 'p2' }]).length === 2
);
// ...and a row whose speaker identity went missing is not "the same speaker"
// either: nothing can be verified, so the rows stay apart.
check(
  'a missing speaker identity never merges',
  mergeTurnRows([eagerRow, { ...tailRow, speakerId: '' }]).length === 2
);
check(
  'a new turn is its own line, even opening with the same words',
  mergeTurnRows([eagerRow, { ...tailRow, turnSeq: 8 }]).length === 2
);
check(
  'a same-turn rewrite appends instead of swallowing the row before it',
  (() => {
    const rows = mergeTurnRows([
      eagerRow,
      { ...tailRow, text: 'completely different', turnText: 'completely different' },
    ]);
    return rows.length === 2 && rows[0].text === EAGER_TEXT && rows[1].text === 'completely different';
  })()
);

// SAFETY: no turn identity, no join. This is also the RED STATE the persisted
// columns exist to fix — a row written before they existed, or by an adapter that
// never re-emits a turn, keeps exactly its counted text.
check(
  'rows without turn provenance pass through unchanged',
  (() => {
    const rows = mergeTurnRows([
      { id: 'r1', speakerId: 'p1', text: EAGER_TEXT, createdAt: '2026-09-25T10:00:00.000Z' },
      { id: 'r2', speakerId: 'p1', text: TAIL_TEXT, createdAt: '2026-09-25T10:00:05.000Z' },
    ]);
    return rows.length === 2 && rows[0].text === EAGER_TEXT && rows[1].text === TAIL_TEXT;
  })()
);

// A sentence genuinely said twice must STAY twice: the transcript is a log, so
// this merge must not inherit collapseCaptions' duplicate-final dedupe.
const repeated = 'yes we can ship it tonight';
check(
  'a sentence said twice keeps both lines',
  mergeTurnRows([
    { id: 'a1', speakerId: 'p1', text: repeated, turnText: repeated, turnSeq: 21, createdAt: '2026-09-25T10:01:00.000Z' },
    { id: 'a2', speakerId: 'p1', text: repeated, turnText: repeated, turnSeq: 22, createdAt: '2026-09-25T10:01:20.000Z' },
  ]).length === 2
);

// Grouping is by turn identity, not by position: a resumed turn's tail can land
// seconds later, with another speaker's words in between.
const interleaved = mergeTurnRows([
  eagerRow,
  { id: 'x1', speakerId: 'p2', participantName: 'Bo', text: 'quick aside from Bo', createdAt: '2026-09-25T10:00:02.000Z' },
  tailRow,
]);
check(
  'an interleaved turn still joins into one line',
  interleaved.length === 2 && interleaved[1]?.text === TURN_TEXT,
  `rows=${interleaved.length}`
);

// Postgres does not order rows that share a `created_at`, and the two halves of a
// resumed turn can land in the same millisecond. The fold must therefore not
// depend on the order the rows come back in — and the merged row has to keep the
// identity of the fragment that finished the sentence, whichever row that was.
check(
  'the join does not depend on row order',
  (() => {
    const rows = mergeTurnRows([tailRow, eagerRow]);
    return rows.length === 1 && rows[0].text === TURN_TEXT && rows[0].id === 'r2';
  })()
);

console.log('--- one rule, two copies: the client and the server must agree ---');

// The server cannot import src/lib/stt/captionRows.ts (different tsconfig rootDir),
// so the rule is duplicated there on purpose. These cases are what keeps the two
// copies honest: the same rows through both code paths must decide identically.
const toClientCaption = (r) => ({
  speakerId: r.speakerId,
  speakerName: r.participantName ?? null,
  text: r.text,
  turnText: r.turnText,
  turnSeq: r.turnSeq,
  isFinal: true,
  timestamp: new Date(r.createdAt).getTime(),
});
for (const [label, rows] of [
  ['the resumed turn', [eagerRow, tailRow]],
  ['a new turn with the same opening words', [eagerRow, { ...tailRow, turnSeq: 8 }]],
  ['a same-turn rewrite', [eagerRow, { ...tailRow, text: 'completely different', turnText: 'completely different' }]],
]) {
  const drawn = collapseCaptions(rows.map(toClientCaption)).map((r) => r.text);
  const stored = mergeTurnRows(rows).map((r) => r.text);
  check(
    `client and server agree on ${label}`,
    drawn.join(' | ') === stored.join(' | '),
    `client=[${drawn.join(' | ')}] server=[${stored.join(' | ')}]`
  );
}

console.log('--- game quotes: the whole turn, never the tail fragment ---');

const utterance = (over = {}) => ({
  speakerId: 'p1',
  text: EAGER_TEXT,
  turnText: EAGER_TEXT,
  turnSeq: 7,
  timestamp: 1_700_000_000_000,
  ...over,
});
const eagerU = utterance();
const tailU = utterance({ text: TAIL_TEXT, turnText: TURN_TEXT, timestamp: 1_700_000_001_000 });
// The buffer a round is built from holds BOTH emissions of the turn.
const pool = [eagerU, tailU];
const people = [
  { id: 'p1', name: 'Cloud' },
  { id: 'p2', name: 'Bo' },
];

check(
  'a fragment with no turn identity is left exactly as it is',
  resolveTurnText(
    [{ speakerId: 'p1', text: 'hello there friend' }],
    { speakerId: 'p1', text: 'hello there friend' }
  ) === 'hello there friend'
);

// Only the tail (10 words) clears validateQuote's 10-word gate, so the pick is
// deterministic — and it is exactly the bug case: a long continuation quoted
// alone ("morning before the demo starts...") as if it were the whole thought.
const whoRound = makeWhoSaidThatRound(pool, people);
check('Who Said That quotes the whole turn', whoRound?.quote === TURN_TEXT, `quote="${whoRound?.quote}"`);
check('the quote keeps its speaker', whoRound?.speakerId === 'p1');

// Both halves clear the quiz's 8-word gate, so the pick is random: the prompt has
// to come out whole whichever half was chosen.
const quizCtx = (utterances) => ({ utterances, participants: people, durationSec: 300 });
const whoSaidPrompts = Array.from(
  { length: 8 },
  () => buildQuizQuestions(quizCtx(pool)).find((q) => q.id === 'who_said')?.prompt
);
check(
  'the recap quiz quotes the whole turn, whichever half it picked',
  whoSaidPrompts.every((p) => p === `Who said: "${TURN_TEXT}"?`),
  `prompts=${JSON.stringify([...new Set(whoSaidPrompts)])}`
);

// The constraint the whole change hangs on: only QUOTE text may use the fuller
// wording. Word frequencies are a COUNTER, so turn provenance must not move a
// single count — `release` stays 3, not the doubled 6.
const withProvenance = buildQuizQuestions(quizCtx(pool)).find((q) => q.id === 'most_used');
const withoutProvenance = buildQuizQuestions(
  quizCtx([
    { speakerId: 'p1', text: EAGER_TEXT, timestamp: 1 },
    { speakerId: 'p1', text: TAIL_TEXT, timestamp: 2 },
  ])
).find((q) => q.id === 'most_used');
check(
  'turn provenance does not change the word count',
  withProvenance?.prompt === withoutProvenance?.prompt,
  `with="${withProvenance?.prompt}" without="${withoutProvenance?.prompt}"`
);
check(
  'the shared prefix is counted once (release x3, not x6)',
  withProvenance?.prompt === 'Which word was said the most (3 times)?',
  `prompt="${withProvenance?.prompt}"`
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
