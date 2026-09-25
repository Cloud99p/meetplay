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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
