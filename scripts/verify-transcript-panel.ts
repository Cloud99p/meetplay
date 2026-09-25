/**
 * Verifies the transcript panel's three display modes and its interim/final
 * collapsing, by rendering the REAL component (react-dom/server) and asserting
 * on the markup. There is no browser runner in this repo, so this is the
 * strongest available check of the panel's rendering logic.
 *
 * Why the collapsing matters: the STT engine emits an interim result and then a
 * refined final for the same utterance. Rendering the raw array would stack a
 * stale half-sentence above the finished one, or duplicate the phrase. The
 * collapse is presentation-only — it must never touch state.captions, which
 * games and the recap read.
 *
 * Usage (from the repo root):
 *   npx tsx scripts/verify-transcript-panel.ts
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import TranscriptPanel from '../src/components/meeting/TranscriptPanel.tsx';

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

// 1. hidden renders nothing at all
check('mode=hidden renders no panel', render([cap()], 'hidden') === '');

// 2. modal states when there is nothing to show
const off = render([], 'visible', false, true);
check('transcription off explains itself', off.includes('Transcription is off'));
check('host gets an enable button when transcription is off', off.includes('Turn on transcription'));
check('non-host gets no enable button', !render([], 'visible', false, false).includes('Turn on transcription'));
check('transcription on with no speech shows listening state', render([], 'visible', true).includes('Listening'));

// 3. two speakers, finals only — both lines, both names
const twoSpeakers = render([
  cap({ speakerId: 'a', speakerName: 'Ada', text: 'first line', timestamp: 1 }),
  cap({ speakerId: 'b', speakerName: 'Bo', text: 'second line', timestamp: 2 }),
]);
check('both finals render', twoSpeakers.includes('first line') && twoSpeakers.includes('second line'));
check('both speakers are named', twoSpeakers.includes('Ada') && twoSpeakers.includes('Bo'));
check('consent promise is shown next to the text', twoSpeakers.includes('deleted when the meeting ends'));

// 4. interim then final for the SAME utterance -> one line, not two
const interimThenFinal = render([
  cap({ speakerId: 'a', text: 'we should ship', isFinal: false, timestamp: 10 }),
  cap({ speakerId: 'a', text: 'we should ship it friday', isFinal: true, timestamp: 11 }),
]);
check(
  'final supersedes its interim (no stale half-sentence)',
  count(interimThenFinal, 'we should ship') === 1 && interimThenFinal.includes('we should ship it friday'),
  `occurrences of interim text = ${count(interimThenFinal, 'we should ship')}`
);
check('the settled line is no longer marked live', !interimThenFinal.includes('animate-pulse'));

// 5. two interims in a row -> only the later text survives
const twoInterims = render([
  cap({ speakerId: 'a', text: 'so the plan', isFinal: false, timestamp: 20 }),
  cap({ speakerId: 'a', text: 'so the plan is', isFinal: false, timestamp: 21 }),
]);
check(
  'later interim replaces the earlier one',
  twoInterims.includes('so the plan is') && !twoInterims.includes('so the plan</span>'),
  'earlier interim text must not survive as its own line'
);

// 6. an interim from ANOTHER speaker must not clobber the pending line
const interleaved = render([
  cap({ speakerId: 'a', speakerName: 'Ada', text: 'ada pending', isFinal: false, timestamp: 30 }),
  cap({ speakerId: 'b', speakerName: 'Bo', text: 'bo pending', isFinal: false, timestamp: 31 }),
]);
check(
  'interleaved speakers both keep their line',
  interleaved.includes('ada pending') && interleaved.includes('bo pending')
);

// 7. a lone interim still renders, and is visibly live
const liveOnly = render([cap({ text: 'still talking', isFinal: false, timestamp: 40 })]);
check('lone interim renders live', liveOnly.includes('still talking') && liveOnly.includes('animate-pulse'));

// 8. low-confidence finals are dimmed (same floor the server uses for games)
check('low-confidence line is dimmed', render([cap({ confidence: 0.2 })]).includes('opacity-60'));
check('confident line is not dimmed', !render([cap({ confidence: 0.95 })]).includes('opacity-60'));

// 9. the mode control reports the current mode
check('header reports Visible', render([cap()], 'visible').includes('Visible'));
check('header reports Transparent', render([cap()], 'transparent').includes('Transparent'));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
