// Caption flow test: toggle transcription, send caption:event, verify broadcast.
// Usage: node scripts/caption-test.mjs <port>
const PORT = Number(process.argv[2] || 3210);
const BASE = `http://localhost:${PORT}`;
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // Create room (host)
  const create = await (await fetch(`${BASE}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'host-1' }),
  })).json();
  const roomId = create.room.id;
  ok('room created', !!roomId);

  // Toggle transcription on (host-only)
  const toggle = await (await fetch(`${BASE}/api/rooms/${roomId}/transcript/toggle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${create.token}` },
    body: JSON.stringify({ enabled: true }),
  })).json();
  ok('transcription toggled on', toggle.enabled === true, JSON.stringify(toggle));

  // Guest joins with WS
  const join = await (await fetch(`${BASE}/api/rooms/${roomId}/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantName: 'Listener', userId: 'guest-1' }),
  })).json();
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?roomId=${roomId}&participantId=${join.participant.id}&token=${join.token}`);
  const wsMsgs = [];
  ws.on('message', (d) => wsMsgs.push(JSON.parse(d.toString())));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await sleep(400);

  // Host sends a caption via its own WS (need host ws too)
  const hostWs = new WebSocket(`ws://localhost:${PORT}/ws?roomId=${roomId}&participantId=${create.participant.id}&token=${create.token}`);
  await new Promise((res, rej) => { hostWs.on('open', res); hostWs.on('error', rej); });
  await sleep(400);

  hostWs.send(JSON.stringify({ type: 'caption:event', payload: { speakerId: 'mock-1', text: 'The roadmap is not a wishlist, it is a commitment.', isFinal: true } }));
  await sleep(600);

  const got = wsMsgs.find((m) => m.type === 'caption:event' && m.payload?.text?.includes('wishlist'));
  ok('caption:event broadcast to guest', !!got, got ? `text="${got.payload?.text?.slice(0, 40)}…"` : 'none');

  ws.close(); hostWs.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n=== ${results.length - failed}/${results.length} passed ===`);
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
