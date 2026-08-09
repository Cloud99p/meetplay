// Quick functional test of the client-side game libs (pure functions).
// Run with: node --experimental-strip-types? No — use tsx.
import { transitionState, roundTimeLeft, sortLeaderboard } from '../src/lib/games/engine.js';
import { qualityCheck, selectRandomQuote, scoreSubmission } from '../src/lib/games/whoSaidThat.js';
import { buildWordBank, validateWord, calculateScore } from '../src/lib/games/scrabble.js';
import { selectTargetWord, countOccurrences, closestGuess, calculateBetScore } from '../src/lib/games/wordCountBet.js';

const results = [];
const ok = (name, cond, extra = '') => { results.push(!!cond); console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`); };

// engine
const t = transitionState('idle', 'open');
ok('transitionState', t.state === 'open' && typeof t.timestamp === 'number');
ok('roundTimeLeft', roundTimeLeft(new Date().toISOString(), 30) > 28 && roundTimeLeft(new Date(Date.now() - 40000).toISOString(), 30) === 0);
ok('sortLeaderboard', sortLeaderboard([{ pointsPerRound: 5 }, { pointsPerRound: 9 }], true)[0].pointsPerRound === 9);

// whoSaidThat
const utts = [
  { speakerId: 'a', text: 'I think we should ship the beta by Friday and then celebrate the launch together.', timestamp: 1 },
  { speakerId: 'b', text: 'The roadmap is not a wishlist, it is a commitment to the whole team.', timestamp: 2 },
  { speakerId: 'a', text: 'short', timestamp: 3 },
];
ok('qualityCheck pass', qualityCheck(utts[0], utts).pass === true);
ok('qualityCheck reject short', qualityCheck(utts[2], utts).pass === false, qualityCheck(utts[2], utts).reason);
const q = selectRandomQuote(utts, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }]);
ok('selectRandomQuote 4 options', !!q && q.options.length === 4 && q.options.some((o) => o.id === q.speakerId), q ? `quote="${q.quote.slice(0, 25)}…"` : 'null');
ok('scoreSubmission speed bonus', scoreSubmission(1000, true, 30000) > scoreSubmission(20000, true, 30000), `fast=${scoreSubmission(1000, true, 30000)} slow=${scoreSubmission(20000, true, 30000)}`);
ok('scoreSubmission wrong=0', scoreSubmission(500, false, 30000) === 0);

// scrabble
const bank = buildWordBank(utts);
ok('buildWordBank dedup+sort', bank.includes('roadmap') && bank.length === new Set(bank).size, `${bank.length} words`);
ok('validateWord', validateWord('roadmap', bank) === true && validateWord('zzzqqq', bank) === false);
// Letter pool spelled from the played words (pool arg), other submissions as
// the 4th arg: 'roadmap' is unique (+500), 'beta' was played by someone else.
const pool = [...'roadmapbeta'.split('')];
const sc = calculateScore(['roadmap', 'beta'], bank, pool, [{ words: ['beta'] }]);
ok('calculateScore uniqueness bonus', sc.points === 1350 && sc.uniquenessBonus === 500, `points=${sc.points} bonus=${sc.uniquenessBonus}`);

// wordCountBet
const target = selectTargetWord(utts);
ok('selectTargetWord', typeof target === 'string' && target.length > 0, `target="${target}"`);
ok('countOccurrences substring', countOccurrences('roadmap', utts) >= 1);
ok('closestGuess', closestGuess([5, 8, 12], 10) === 8);
ok('calculateBetScore exact=1000', calculateBetScore(10, 10) === 1000 && calculateBetScore(13, 10) < 1000);

const failed = results.filter((r) => !r).length;
console.log(`\n=== ${results.length - failed}/${results.length} passed ===`);
process.exit(failed ? 1 : 0);
