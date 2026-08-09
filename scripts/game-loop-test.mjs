// Full game loop test: feed mock captions → verify a round opens.
// Usage: node scripts/game-loop-test.mjs <port>
const PORT = Number(process.argv[2] || 3210);
const BASE = `http://localhost:${PORT}`;
const results = [];
const ok = (name, cond, extra = '') => { results.push(!!cond); console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WebSocket = (await import('ws')).default;

// Mock script that exercises all games (roadmap-heavy, quotable lines)
const LINES = [
  'I think we should ship the beta by Friday and then celebrate the launch together.',
  'The roadmap is not a wishlist, it is a commitment to the whole team.',
  'Let us align on the deliverables before we scale the roadmap further.',
  'Speaking of deployment, we should finalise the roadmap for the next quarter release cycle.',
  'Absolutely, the roadmap priority should be performance improvements and the new onboarding flow.',
  'I think the roadmap planning needs to include the mobile responsive design updates for the app.',
  'We have a hard deadline next Tuesday, so please keep the sync short today.',
  'The database optimisation project is almost complete and we should see better query performance.',
  'Excellent progress everyone. Let me check if there are any other updates before we wrap up.',
  'I think we should consider adding monitoring alerts for the new services we are deploying.',
  'Monitoring alerts would be very helpful for catching issues early in the development cycle.',
  'I can set up the monitoring dashboard this afternoon if we decide on the metrics to track.',
];

try {
  const create = await (await fetch(`${BASE}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'host-1' }),
  })).json();
  const roomId = create.room.id;
  ok('room created', !!roomId);

  // Enable transcription (required for captions to reach the engine)
  await fetch(`${BASE}/api/rooms/${roomId}/transcript/toggle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${create.token}` },
    body: JSON.stringify({ enabled: true }),
  });

  // Host WS (feeds captions) + listener WS
  const mk = (pid, tok) => new WebSocket(`ws://localhost:${PORT}/ws?roomId=${roomId}&participantId=${pid}&token=${tok}`);
  const hostWs = mk(create.participant.id, create.token);
  const msgs = [];
  await new Promise((res, rej) => { hostWs.on('open', res); hostWs.on('error', rej); });
  // Listener joins as a SEPARATE participant (distinct id + token)
  const join = await (await fetch(`${BASE}/api/rooms/${roomId}/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantName: 'Listener', userId: 'listener-1' }),
  })).json();
  const listener = mk(join.participant.id, join.token);
  await new Promise((res, rej) => { listener.on('open', res); listener.on('error', rej); });
  listener.on('message', (d) => msgs.push(JSON.parse(d.toString())));

  // Feed 12 captions, one per 300ms
  for (let i = 0; i < LINES.length; i++) {
    hostWs.send(JSON.stringify({
      type: 'caption:event',
      payload: { speakerId: i % 2 === 0 ? 'mock-1' : 'mock-2', text: LINES[i], isFinal: true },
    }));
    await sleep(300);
  }

  // Rounds are player-chosen since the redesign (only Flash WCB auto-opens):
  // start one explicitly once there's enough conversation to build from.
  hostWs.send(JSON.stringify({ type: 'game:start', payload: { gameType: 'who_said_that' } }));

  // Wait for the round to open (engine needs 8+ utterances)
  const deadline = Date.now() + 8000;
  let opened = null;
  while (Date.now() < deadline) {
    opened = msgs.find((m) => m.type === 'game:round:open');
    if (opened) break;
    await sleep(300);
  }
  ok('game round opened after 8+ utterances', !!opened, opened ? `${opened.payload?.gameType} (${opened.payload?.roundId?.slice(0,8)})` : 'no round');

  // Wait for lock + scored (scrabble limit is 45s; wait up to 80s)
  const deadline2 = Date.now() + 80000;
  let locked = false, scored = false;
  while (Date.now() < deadline2) {
    if (msgs.some((m) => m.type === 'game:round:locked')) locked = true;
    if (msgs.some((m) => m.type === 'game:round:scored')) scored = true;
    if (locked && scored) break;
    await sleep(1000);
  }
  ok('round locked', locked);
  ok('round scored', scored);
  ok('leaderboard updated', msgs.some((m) => m.type === 'leaderboard:update' || (m.type === 'game:round:scored')));

  hostWs.close(); listener.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n=== ${results.length - failed}/${results.length} passed ===`);
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
