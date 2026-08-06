// Quick recap inspection: print full round submissions.
const PORT = Number(process.argv[2] || 3210);
const BASE = `http://localhost:${PORT}`;
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
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); msgs.push(m); if (m.type.startsWith('game:') || m.type === 'leaderboard:update') console.log('EVENT:', m.type, JSON.stringify(m.payload).slice(0, 200)); });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await sleep(400);

  for (let i = 0; i < LINES.length; i++) {
    ws.send(JSON.stringify({ type: 'caption:event', payload: { speakerId: i % 2 === 0 ? 'mock-1' : 'mock-2', text: LINES[i], isFinal: true } }));
    await sleep(250);
  }

  // Wait for open, submit
  const deadline = Date.now() + 8000;
  let openMsg = null;
  while (Date.now() < deadline && !openMsg) {
    openMsg = msgs.find((m) => m.type === 'game:round:open');
    await sleep(300);
  }
  console.log('OPEN:', openMsg ? JSON.stringify(openMsg.payload).slice(0, 250) : 'NONE');
  if (openMsg) {
    const answer = openMsg.payload?.gameType === 'who_said_that'
      ? { answer: 'mock-1' }
      : openMsg.payload?.gameType === 'scrabble'
        ? { words: ['roadmap', 'deadline'] }
        : { guess: 5 };
    console.log('SUBMITTING:', JSON.stringify(answer));
    ws.send(JSON.stringify({ type: 'game:submit', payload: { roundId: openMsg.payload.roundId, answer } }));
  }

  // Wait for scored
  const d2 = Date.now() + 50000;
  while (Date.now() < d2) {
    if (msgs.some((m) => m.type === 'game:round:scored')) break;
    await sleep(1000);
  }
  const scored = msgs.find((m) => m.type === 'game:round:scored');
  console.log('SCORED:', scored ? JSON.stringify(scored.payload).slice(0, 300) : 'NONE');

  // Fetch recap raw
  const recap = await (await fetch(`${BASE}/api/rooms/${roomId}/recap`)).json();
  console.log('RECAP gameRounds:', JSON.stringify(recap.gameRounds).slice(0, 600));
  console.log('RECAP leaderboard:', JSON.stringify(recap.leaderboard));
  ws.close();
  process.exit(0);
} catch (e) { console.error('ERROR:', e.message); process.exit(1); }
