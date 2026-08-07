// Smoke test: boots against a running server on :3999, creates a room,
// connects two WS clients, feeds captions, and asserts the always-on games
// (market open, market odds, bingo marks, stats) emit as expected.
import WebSocket from 'ws';

const BASE = 'http://localhost:3999';

async function api(path, opts = {}) {
  const { headers, ...rest } = opts;
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    ...rest,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const roomName = `Q3 Roadmap Review ${Date.now()}`;
const room = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: roomName }) });
console.log('room:', room.room.id, 'host:', room.participant.id);

// Enable transcription — captions are the fuel for all games
const toggleResp = await api(`/api/rooms/${room.room.id}/transcript/toggle`, {
  method: 'POST',
  body: JSON.stringify({ enabled: true }),
  headers: { Authorization: `Bearer ${room.token}` },
});
console.log('transcription enabled:', JSON.stringify(toggleResp));
const roomCheck = await api(`/api/rooms/${room.room.id}`);
console.log('room state transcriptionEnabled:', roomCheck.room.transcriptionEnabled);

// Second participant
const join = await api(`/api/rooms/${room.room.id}/join`, {
  method: 'POST',
  body: JSON.stringify({ name: 'Alex' }),
});

function connect(roomId, participantId, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:3999/ws?roomId=${roomId}&participantId=${participantId}&token=${encodeURIComponent(token)}`);
    const events = [];
    ws.on('open', () => resolve({ ws, events }));
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      events.push(msg);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

const host = await connect(room.room.id, room.participant.id, room.token);
const guest = await connect(room.room.id, join.participant.id, join.token);

await new Promise((r) => setTimeout(r, 500));
console.log('host event types:', host.events.map((e) => e.type).join(', ') || '(none)');
// Both should have gotten room:state with market + bingo
const hostState = host.events.find((e) => e.type === 'room:state');
console.log('hostState present:', Boolean(hostState));
console.log('market in state:', hostState?.payload?.market ? { targetWord: hostState.payload.market.targetWord, resolved: hostState.payload.market.resolved } : 'NONE');
console.log('bingo in state:', hostState?.payload?.bingo ? `round ${hostState.payload.bingo.roundNumber} card ${hostState.payload.bingo.myCard.length} words` : 'NONE');

// Host sends a stream of captions (final utterances)
const sendCaption = (ws, speakerId, text) =>
  ws.send(JSON.stringify({ type: 'caption:event', payload: { speakerId, text, isFinal: true } }));

// Make the market word appear several times + bingo words
const bingoWords = ['synergy', 'roadmap', 'deadline', 'kpi', 'bandwidth'];
for (let i = 0; i < 6; i++) {
  sendCaption(host.ws, room.participant.id, `Let me share the roadmap status with you today.`);
  sendCaption(host.ws, room.participant.id, `The roadmap deadline is important, we need the synergy across teams.`);
  sendCaption(guest.ws, join.participant.id, `Agreed, the kpi for this roadmap is bandwidth and deadlines.`);
  await new Promise((r) => setTimeout(r, 150));
}
// Enough filler words for stats
sendCaption(host.ws, room.participant.id, `Um, like, actually we should um review the kpi numbers okay.`);
sendCaption(guest.ws, join.participant.id, `Well, um, I mean the synergy stuff is basically fine okay.`);

await new Promise((r) => setTimeout(r, 2500));

const types = (c) => c.events.map((e) => e.type).filter((t) => t.startsWith('game:market') || t.startsWith('bingo') || t.startsWith('stats'));
console.log('host saw:', [...new Set(types(host))].join(', '));
console.log('guest saw:', [...new Set(types(guest))].join(', '));

const marketUpdate = host.events.find((e) => e.type === 'game:market:update');
console.log('market update:', marketUpdate ? `count=${marketUpdate.payload.liveCount} odds=${JSON.stringify(marketUpdate.payload.odds)}` : 'NONE');

const bingoMark = host.events.find((e) => e.type === 'bingo:mark');
console.log('bingo mark (host):', bingoMark ? `indices=${bingoMark.payload.indices.join(',')}` : 'NONE');
const guestBingoMark = guest.events.find((e) => e.type === 'bingo:mark');
console.log('bingo mark (guest):', guestBingoMark ? `indices=${guestBingoMark.payload.indices.join(',')}` : 'NONE');

const statsUpd = host.events.find((e) => e.type === 'stats:update');
console.log('stats update:', statsUpd ? `${statsUpd.payload.stats.length} speakers, top fillers=${statsUpd.payload.stats[0]?.fillers}` : 'NONE');

// ── Flash WCB: waits for a random window, then bets on it ──
console.log('waiting for flash WCB window (up to 75s)...');
let flashOpen = null;
for (let i = 0; i < 75; i++) {
  flashOpen = host.events.find((e) => e.type === 'game:flash:open');
  if (flashOpen) break;
  await new Promise((r) => setTimeout(r, 1000));
}
if (flashOpen) {
  console.log('flash open:', `${flashOpen.payload.targetWord} window=${Math.round(flashOpen.payload.windowMs / 1000)}s ends=${flashOpen.payload.endsAt}`);
  // Guest bets during the flash window
  guest.ws.send(JSON.stringify({ type: 'game:submit', payload: { roundId: flashOpen.payload.roundId, answer: { guess: 8 } } }));
  await new Promise((r) => setTimeout(r, 800));
  const flashBet = host.events.find((e) => e.type === 'game:flash:bet');
  console.log('flash bet:', flashBet ? `guest guessed ${flashBet.payload.guess} @ x${flashBet.payload.lockedOdds}` : 'NONE');
  const flashUpd = host.events.find((e) => e.type === 'game:flash:update');
  console.log('flash update:', flashUpd ? `count=${flashUpd.payload.liveCount} remainingMs=${flashUpd.payload.remainingMs}` : 'NONE');
  // Wait for the window to resolve (up to 150s)
  console.log('waiting for flash resolution...');
  for (let i = 0; i < 150; i++) {
    if (host.events.some((e) => e.type === 'game:flash:resolved')) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const flashResolved = host.events.find((e) => e.type === 'game:flash:resolved');
  console.log('flash resolved:', flashResolved ? `count=${flashResolved.payload.actualCount} results=${flashResolved.payload.results.length}` : 'NONE');
} else {
  console.log('flash WCB: NO OPEN EVENT within 75s');
}

// Guest places a market bet
if (marketUpdate) {
  guest.ws.send(JSON.stringify({ type: 'game:submit', payload: { roundId: marketUpdate.payload.roundId, answer: { guess: 12 } } }));
  await new Promise((r) => setTimeout(r, 800));
  const betEvt = host.events.find((e) => e.type === 'game:market:bet');
  console.log('market bet:', betEvt ? `guest guessed ${betEvt.payload.guess} @ x${betEvt.payload.lockedOdds}` : 'NONE');
} else {
  console.log('market bet: SKIPPED (no market update)');
}

// End the meeting (host) -> market resolves
host.ws.send(JSON.stringify({ type: 'room:end', payload: {} }));
await new Promise((r) => setTimeout(r, 1500));
const resolved = host.events.find((e) => e.type === 'game:market:resolved');
console.log('market resolved:', resolved ? `count=${resolved.payload.actualCount} results=${resolved.payload.results.length}` : 'NONE');
const quiz = await api(`/api/rooms/${room.room.id}/recap`).catch((e) => ({ error: e.message }));
const quizRound = quiz.gameRounds?.find((r) => r.gameType === 'recap_quiz');
console.log('recap quiz round:', quizRound ? `${quizRound.roundData.questions.length} questions` : 'NONE');
const wcbRound = quiz.gameRounds?.find((r) => r.gameType === 'word_count_bet');
console.log('wcb round in recap:', wcbRound ? `actualCount=${wcbRound.roundData.actualCount}` : 'NONE');
const flashRound = quiz.gameRounds?.find((r) => r.gameType === 'flash_wcb');
console.log('flash round in recap:', flashRound ? `${flashRound.roundData.targetWord} actualCount=${flashRound.roundData.actualCount}` : 'NONE');

host.ws.close(); guest.ws.close();
console.log('SMOKE DONE');
process.exit(0);
