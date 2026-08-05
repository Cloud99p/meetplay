// WS round-trip test. Connects to an ALREADY-RUNNING MeetPlay server on PORT.
// Usage: node scripts/ws-test.mjs <port>
import WebSocket from 'ws';

const PORT = Number(process.argv[2] || 3210);
const BASE = `http://localhost:${PORT}`;
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // Create room
  const createRes = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostName: 'Host' }),
  });
  const room = await createRes.json();
  const roomId = room.room?.id;
  ok('create room', createRes.ok && !!roomId, `id=${roomId}`);

  // Two participants
  const joinA = await (await fetch(`${BASE}/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantName: 'Alice' }),
  })).json();
  const joinB = await (await fetch(`${BASE}/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantName: 'Bob' }),
  })).json();
  ok('two participants joined', !!joinA.participant?.id && !!joinB.participant?.id && joinA.participant?.id !== joinB.participant?.id,
    `A=${joinA.participant?.id?.slice(0,8)} B=${joinB.participant?.id?.slice(0,8)}`);

  const wsUrl = (pid) => (tok) => `ws://localhost:${PORT}/ws?roomId=${roomId}&participantId=${pid}&token=${tok}`;
  const aUrl = wsUrl(joinA.participant.id);
  const bUrl = wsUrl(joinB.participant.id);
  const a = new WebSocket(aUrl(joinA.token));
  const b = new WebSocket(bUrl(joinB.token));
  const aMsgs = [], bMsgs = [];
  // Attach message handlers BEFORE open so no early (connect-time) message is dropped
  a.on('message', (d) => aMsgs.push(JSON.parse(d.toString())));
  b.on('message', (d) => bMsgs.push(JSON.parse(d.toString())));
  const ready = (ws) => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await Promise.all([ready(a), ready(b)]);
  ok('WS connects (A + B)', true);

  // Give the connect-time room:state snapshot a tick to arrive
  await sleep(500);

  // chat
  a.send(JSON.stringify({ type: 'chat:send', payload: { content: 'hey bob' } }));
  await sleep(600);
  ok('chat:received → B hears A', bMsgs.some((m) => m.type === 'chat:received' && m.payload?.content === 'hey bob'));

  // emoji
  a.send(JSON.stringify({ type: 'emoji:send', payload: { emoji: '🎉' } }));
  await sleep(600);
  const em = bMsgs.find((m) => m.type === 'emoji:received');
  ok('emoji:received → B', !!em && em.payload?.emoji === '🎉',
    em ? `emoji=${em.payload?.emoji} name=${em.payload?.participantName}` : 'none');

  // room:state snapshot is pushed on connect (not a client-queryable message type)
  await sleep(500);
  ok('room:state snapshot on connect', aMsgs.some((m) => m.type === 'room:state' && Array.isArray(m.payload?.participants)),
    `A got ${aMsgs.filter((m) => m.type === 'room:state').length} snapshots`);

  a.close(); b.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n=== ${results.length - failed}/${results.length} passed ===`);
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}