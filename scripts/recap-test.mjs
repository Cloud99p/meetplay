// Recap test: run a room with captions, play a round, end it, fetch recap.
// Verifies leaderboard + keyQuotes appear in the recap payload.
const PORT = Number(process.argv[2] || 3210);
const BASE = `http://localhost:${PORT}`;
const results = [];
const ok = (name, cond, extra = '') => { results.push(!!cond); console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WebSocket = (await import('ws')).default;

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

  // Join a second participant so Who Said That can build 4 options
  await fetch(`${BASE}/api/rooms/${roomId}/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantName: 'Listener', userId: 'guest-1' }),
  });

  await fetch(`${BASE}/api/rooms/${roomId}/transcript/toggle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${create.token}` },
    body: JSON.stringify({ enabled: true }),
  });

  const ws = new WebSocket(`ws://localhost:${PORT}/ws?roomId=${roomId}&participantId=${create.participant.id}&token=${create.token}`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await sleep(400);

  // Feed captions
  for (let i = 0; i < LINES.length; i++) {
    ws.send(JSON.stringify({ type: 'caption:event', payload: { speakerId: i % 2 === 0 ? 'mock-1' : 'mock-2', text: LINES[i], isFinal: true } }));
    await sleep(250);
  }

  // Wait for a round to open then finish (first game is who_said_that, 30s)
  const waitFor = async (type, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (msgs.some((m) => m.type === type)) return true;
      await sleep(1000);
    }
    return false;
  };
  ok('round opened', await waitFor('game:round:open', 8000));

  // Submit an answer once the round opens (host answers with mock-1)
  const openMsg = msgs.find((m) => m.type === 'game:round:open');
  if (openMsg) {
    const answer = openMsg.payload?.gameType === 'who_said_that'
      ? { answer: 'mock-1' }
      : openMsg.payload?.gameType === 'scrabble'
        ? { words: ['roadmap', 'deadline'] }
        : { guess: 5 };
    ws.send(JSON.stringify({ type: 'game:submit', payload: { roundId: openMsg.payload.roundId, answer } }));
  }

  ok('round scored', await waitFor('game:round:scored', 45000));

  // End room (simulate meeting end)
  await fetch(`${BASE}/api/rooms/${roomId}/end`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${create.token}` },
  }).catch(() => {});

  // Fetch recap
  const recapRes = await fetch(`${BASE}/api/rooms/${roomId}/recap`);
  const recap = await recapRes.json();
  ok('recap loads', recapRes.ok && !!recap.room, `status=${recapRes.status}`);
  ok('recap has transcript', Array.isArray(recap.transcript) && recap.transcript.length > 0, `${recap.transcript?.length ?? 0} lines`);
  ok('recap has gameRounds', Array.isArray(recap.gameRounds) && recap.gameRounds.length > 0, `${recap.gameRounds?.length ?? 0} rounds`);
  ok('recap has leaderboard', Array.isArray(recap.leaderboard), JSON.stringify(recap.leaderboard?.slice(0, 2)));
  ok('recap has keyQuotes', Array.isArray(recap.keyQuotes), `${recap.keyQuotes?.length ?? 0} quotes`);
  ok('participants have joinedAt', recap.participants?.every((p) => typeof p.joinedAt === 'string'));

  ws.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n=== ${results.length - failed}/${results.length} passed ===`);
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
