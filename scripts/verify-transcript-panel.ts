/**
 * Verifies caption collapsing and the transcript panel's modes, by rendering the
 * REAL component (react-dom/server) and calling the REAL collapse function.
 *
 * The bug this locks down ("its still 3 duplicates"): the engine narrates one
 * sentence repeatedly - an interim per update plus a final - and the client
 * appends every one to `captions`, so any surface showing a window of that array
 * stacked the same words up to three times.
 *
 * Usage (from the repo root):
 *   npm run verify:transcript
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import TranscriptPanel from '../src/components/meeting/TranscriptPanel.tsx';
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

const render = (captions, mode = 'visible', transcriptionEnabled = true, isHost = false) =>
  renderToStaticMarkup(
    createElement(TranscriptPanel, {
      captions,
      mode,
      onModeChange: () => {},
      transcriptionEnabled,
      isHost,
      onEnableTranscription: () => {},
    })
  );

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

// Two genuinely separate sentences stay separate.
const twoSentences = collapseCaptions([
  cap({ text: 'first one', timestamp: 1 }),
  cap({ text: 'second one', timestamp: 2 }),
]);
check('separate sentences are preserved', twoSentences.length === 2);

// Interim refinement.
const refined = collapseCaptions([
  cap({ speakerId: 'a', text: 'so the', isFinal: false, timestamp: 1 }),
  cap({ speakerId: 'a', text: 'so the plan is', isFinal: false, timestamp: 2 }),
]);
check('interim refinement -> one row with the later text', refined.length === 1 && refined[0].text === 'so the plan is');

// The same settled sentence twice (eager final then identical refined final).
const repeat = collapseCaptions([
  cap({ text: 'exactly the same', timestamp: 1 }),
  cap({ text: 'exactly the same', timestamp: 2 }),
]);
check('identical repeated final -> one row', repeat.length === 1);

// A final that does NOT continue the pending line appends rather than clobbers.
const unrelated = collapseCaptions([
  cap({ speakerId: 'local', text: 'okay', isFinal: false, timestamp: 1 }),
  cap({ speakerId: 'local', text: 'completely different sentence here', isFinal: true, timestamp: 2 }),
]);
check('non-continuing final appends', unrelated.length === 2, `rows=${unrelated.length}`);

check('empty input -> empty output', collapseCaptions([]).length === 0);
check('whitespace-only captions are dropped', collapseCaptions([cap({ text: '   ' })]).length === 0);

console.log('--- TranscriptPanel (modes and rendering) ---');

check('mode=hidden renders no panel', render([cap()], 'hidden') === '');

const off = render([], 'visible', false, true);
check('transcription off explains itself', off.includes('Transcription is off'));
check('host gets an enable button when transcription is off', off.includes('Turn on transcription'));
check('non-host gets no enable button', !render([], 'visible', false, false).includes('Turn on transcription'));
check('transcription on with no speech shows listening state', render([], 'visible', true).includes('Listening'));

const two = render([
  cap({ speakerId: 'a', speakerName: 'Ada', text: 'first line', timestamp: 1 }),
  cap({ speakerId: 'b', speakerName: 'Bo', text: 'second line', timestamp: 2 }),
]);
check('both finals render', two.includes('first line') && two.includes('second line'));
check('both speakers are named', two.includes('Ada') && two.includes('Bo'));
check('consent promise is shown next to the text', two.includes('deleted when the meeting ends'));

// The panel renders the COLLAPSED stream, so the duplicate sequence is one line.
const dupes = render([
  cap({ speakerId: 'local', text: 'hello', isFinal: false, timestamp: 1 }),
  cap({ speakerId: 'local', text: 'hello there', isFinal: false, timestamp: 2 }),
  cap({ speakerId: 'local', text: 'hello there', isFinal: true, timestamp: 3 }),
]);
check(
  'panel does not repeat the same sentence',
  count(dupes, 'hello there') === 1 && count(dupes, 'hello') === 1,
  `"hello there" x${count(dupes, 'hello there')}`
);

check('low-confidence line is dimmed', render([cap({ confidence: 0.2 })]).includes('opacity-60'));
check('confident line is not dimmed', !render([cap({ confidence: 0.95 })]).includes('opacity-60'));
check('header reports Visible', render([cap()], 'visible').includes('Visible'));
check('header reports Transparent', render([cap()], 'transparent').includes('Transparent'));
check('panel docks right on desktop', render([cap()]).includes('sm:right-0'));
check('panel is a bottom sheet on phones', render([cap()]).includes('max-h-[45%]'));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
