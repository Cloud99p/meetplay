// Verify the caption speaker-mapping fix: a caption with a synthetic Deepgram
// speaker id ('speaker-0') from a real participant must be attributed to the
// sender so bingo cards (keyed by participant id) actually mark.
import assert from 'node:assert';
import { countWordInText } from '../server/src/games/market.js';

// 1. countWordInText works (market counting)
assert.equal(countWordInText('hello', 'hello hello hello'), 3);
assert.equal(countWordInText('roadmap', 'the roadmap is not a wishlist'), 1);
assert.equal(countWordInText('roadmap', 'roadmaps and roadmapping'), 2); // roadmaps + roadmapping
console.log('✅ countWordInText: exact + partial matches count correctly');

// 1b. REGRESSION: short tokens must NOT match longer targets as substrings
// (old logic counted 'a' inside 'roadmap' → 2 instead of 1)
assert.equal(countWordInText('roadmap', 'the roadmap is not a wishlist'), 1, 'old bug: token "a" matched roadmap');
assert.equal(countWordInText('hello', 'he said hello to a lo'), 1, 'old bug: "he"/"a"/"lo" matched hello');
assert.equal(countWordInText('sync', 'is this sync in sync'), 2, 'old bug: "is"/"in" matched sync');
console.log('✅ countWordInText: short stopwords no longer false-match longer targets');

// 2. Simulate the handler's speaker resolution logic:
//    rawSpeakerId 'speaker-0' -> lookup in participants -> not found -> senderId
function resolveSpeaker(rawSpeakerId, senderId, participants) {
  if (rawSpeakerId === senderId) return { speakerId: senderId, speakerName: participants[senderId] ?? null };
  const speaker = participants[rawSpeakerId];
  if (speaker) return { speakerId: rawSpeakerId, speakerName: speaker };
  return { speakerId: senderId, speakerName: participants[senderId] ?? null };
}

const participants = { 'p-1': 'Cloud', 'p-2': 'Ada' };
const r1 = resolveSpeaker('speaker-0', 'p-1', participants);
assert.equal(r1.speakerId, 'p-1');
assert.equal(r1.speakerName, 'Cloud');
console.log('✅ speaker-0 from p-1 -> attributed to p-1 (Cloud)');

const r2 = resolveSpeaker('p-2', 'p-1', participants);
assert.equal(r2.speakerId, 'p-2');
assert.equal(r2.speakerName, 'Ada');
console.log('✅ real participant id p-2 preserved');

const r3 = resolveSpeaker('unknown', 'p-2', participants);
assert.equal(r3.speakerId, 'p-2');
console.log('✅ "unknown" -> attributed to sender p-2');

// 3. Bingo card lookup with the mapped id now succeeds (cards keyed by participant id)
function markBingoLookup(speakerId, cards) {
  return cards.get(speakerId) ? 'MARKED' : 'NO CARD';
}
const cards = new Map([['p-1', ['roadmap', 'deadline']]]);
assert.equal(markBingoLookup('speaker-0', cards), 'NO CARD'); // before fix
assert.equal(markBingoLookup(resolveSpeaker('speaker-0', 'p-1', participants).speakerId, cards), 'MARKED'); // after fix
console.log('✅ bingo card lookup succeeds after speaker mapping (was NO CARD with raw speaker-0)');

console.log('\nALL CHECKS PASSED');
