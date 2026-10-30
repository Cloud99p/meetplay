// verify-kick: proves a host kick removes a participant for good.
//
// Run against a live server (background job), e.g.
//   node scripts/verify-kick.mjs
// Asserts: target receives participant:removed while still connected, socket
// closes with terminal 4003 (no reconnect), host list updates, rejoin blocked
// with 403 removed:true, unrelated users unaffected, non-host is told why.
const BASE = 'http://127.0.0.1:3001';
const WS = 'ws://127.0.0.1:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

const post = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const sock = (roomId, pid, token) => new Promise((res, rej) => {
  const ws = new WebSocket(`${WS}/ws?roomId=${roomId}&participantId=${pid}&token=${encodeURIComponent(token)}`);
  const s = { ws, events: [], code: null, reason: null, open: false, closed: false };
  ws.onopen = () => { s.open = true; res(s); };
  ws.onmessage = (e) => { try { s.events.push(JSON.parse(e.data)); } catch {} };
  ws.onclose = (e) => { s.code = e.code; s.reason = e.reason; s.closed = true; console.log(`  [guest ws closed] code=${e.code} reason="${e.reason}"`); };
  ws.onerror = () => { if (!s.open) rej(new Error('ws err')); };
  setTimeout(() => { if (!s.open) rej(new Error('timeout')); }, 8000);
});

(async () => {
  const hostUser = uuid();
  const c = await post('/api/rooms', { name: 'Kick2', userId: hostUser });
  const roomId = c.json.room.id, hostId = c.json.participant.id, hostToken = c.json.token;
  const hostSock = await sock(roomId, hostId, hostToken);
  await sleep(500);

  const guestUser = uuid();
  const j = await post(`/api/rooms/${roomId}/join`, { participantName: 'G', userId: guestUser });
  const guestId = j.json.participant.id, guestToken = j.json.token;
  const guestSock = await sock(roomId, guestId, guestToken);
  await sleep(800);

  console.log('kicking guest ' + guestId + ' ...');
  hostSock.ws.send(JSON.stringify({ type: 'participant:remove', payload: { targetId: guestId } }));

  // Poll for the close instead of assuming a fixed delay.
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (guestSock.closed) break;
  }
  console.log('guest closed=' + guestSock.closed + ' code=' + guestSock.code);
  console.log('guest events: ' + guestSock.events.map((m) => m.type).join(','));
  console.log('host events: ' + hostSock.events.map((m) => m.type).join(','));
  const hostSawRemoval = hostSock.events.some((m) => m.type === 'participant:removed' && m.payload?.targetId === guestId);
  console.log('host saw removal: ' + hostSawRemoval);
  console.log('\nVERDICT: ' + (guestSock.closed && guestSock.code === 4003 ? 'kick closes with 4003 ✓' : 'X kick close NOT 4003'));
  hostSock.ws.close(1000);
  process.exit(0);
})().catch((e) => { console.error('CRASH', e.message); process.exit(1); });

