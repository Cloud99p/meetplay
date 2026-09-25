/**
 * Verifies the visible half of raising a hand.
 *
 * Why this exists: the hand-raise plumbing was already correct — the server
 * tracks hands, the client derives them from a Set, and verify:hand round-trips
 * 8/8 over a real socket. Yet clicking the button appeared to do NOTHING,
 * because the only feedback was a tiny glyph on a tile and a latch that waited
 * for the server echo. So the fix is feedback, and feedback is exactly the kind
 * of thing that silently regresses.
 *
 * Asserts:
 *   - a raise and a lower are both detected from the participant list
 *   - the FIRST sighting of a participant is silent (otherwise every hand in the
 *     room would announce itself the moment the list loads or a resync lands)
 *   - an unchanged list announces nothing
 *   - `isSelf` is set correctly, so your own hand is not announced twice
 *   - the toast names the person, says what they did, and differs for self
 *
 * Usage (from the repo root):
 *   npm run verify:hand-notify
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import HandRaiseToasts from '../src/components/meeting/HandRaiseToasts.tsx';
import { diffHands } from '../src/lib/meeting/handEvents.ts';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const p = (id, name, handRaised) => ({ id, name, handRaised });
const render = (announcements) =>
  renderToStaticMarkup(createElement(HandRaiseToasts, { announcements, onDismiss: () => {} }));

console.log('--- diffHands ---');

const raised = diffHands([p('a', 'Ada', false)], [p('a', 'Ada', true)], 'me', 1000);
check('a raise is detected', raised.length === 1 && raised[0].action === 'raised', JSON.stringify(raised.map((r) => r.action)));
check('the announcement names the person', raised[0]?.name === 'Ada');
check('isSelf is false for someone else', raised[0]?.isSelf === false);

const lowered = diffHands([p('a', 'Ada', true)], [p('a', 'Ada', false)], 'me', 1000);
check('a lower is detected', lowered.length === 1 && lowered[0].action === 'lowered');

const own = diffHands([p('me', 'Cloud', false)], [p('me', 'Cloud', true)], 'me', 1000);
check('isSelf is true for yourself', own[0]?.isSelf === true);

// The important safety case: no previous knowledge of a participant means no
// announcement. Otherwise loading the participant list fires a toast for every
// hand already up, and a resync does it all over again.
const firstSight = diffHands([], [p('a', 'Ada', true)], 'me', 1000);
check('first sighting of a participant is silent', firstSight.length === 0, `got ${firstSight.length}`);

const arrived = diffHands([p('a', 'Ada', false)], [p('a', 'Ada', false), p('b', 'Bo', true)], 'me', 1000);
check('a late joiner already raising does not announce', arrived.length === 0, `got ${arrived.length}`);

const unchanged = diffHands([p('a', 'Ada', true), p('b', 'Bo', false)], [p('a', 'Ada', true), p('b', 'Bo', false)], 'me', 1000);
check('an unchanged list announces nothing', unchanged.length === 0);

const both = diffHands(
  [p('a', 'Ada', false), p('b', 'Bo', false)],
  [p('a', 'Ada', true), p('b', 'Bo', true)],
  'me',
  1000
);
check('two people raising together produce two announcements', both.length === 2);
check('announcement ids are unique', new Set(both.map((a) => a.id)).size === 2);

const oneOfTwo = diffHands(
  [p('a', 'Ada', true), p('b', 'Bo', false)],
  [p('a', 'Ada', true), p('b', 'Bo', true)],
  'me',
  1000
);
check('only the change is announced', oneOfTwo.length === 1 && oneOfTwo[0].name === 'Bo');

console.log('--- HandRaiseToasts ---');

const empty = render([]);
check('nothing to announce renders nothing', empty === '');

const otherRaised = render(diffHands([p('a', 'Ada', false)], [p('a', 'Ada', true)], 'me', 1000));
check('names the person who raised', otherRaised.includes('Ada raised their hand'));
check('announcement is announced to screen readers', otherRaised.includes('aria-live="polite"'));

const selfRaised = render(diffHands([p('me', 'Cloud', false)], [p('me', 'Cloud', true)], 'me', 1000));
check('your own raise reads in the first person', selfRaised.includes('You raised your hand'));
check('your own raise does not say "their"', !selfRaised.includes('their hand'));

const otherLowered = render(diffHands([p('a', 'Ada', true)], [p('a', 'Ada', false)], 'me', 1000));
check('a lower is announced too', otherLowered.includes('Ada lowered their hand'));

check('raise and lower are visually distinct', (() => {
  const up = render(diffHands([p('a', 'Ada', false)], [p('a', 'Ada', true)], 'me', 1000));
  const down = render(diffHands([p('a', 'Ada', true)], [p('a', 'Ada', false)], 'me', 1000));
  return up.includes('bg-secondary') && !down.includes('bg-secondary');
})());

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
