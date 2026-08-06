// Debug: does a single caption broadcast? Is transcription actually on?
const PORT = Number(process.argv[2] || 3210);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WebSocket = (await import('ws')).default;

try {
  const create = await (await fetch(`${BASE}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'host-1' }),
  })).json();
  const roomId = create.room.id;
  console.log('room:', roomId, '| token?', !!create.token);

  // Check room state — transcription on?
  const roomInfo = await (await fetch(`${BASE}/api/rooms/${roomId}`)).json();
  console.log('room info:', JSON.stringify(roomInfo));

  const toggle = await fetch(`${BASE}/api/rooms/${roomId}/transcript/toggle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${create.token}` },
    body: JSON.stringify({ enabled: true }),
  });
  console.log('toggle status:', toggle.status, await toggle.text());

  const roomInfo2 = await (await fetch(`${BASE}/api/rooms/${roomId}`)).json();
  console.log('after toggle:', JSON.stringify(roomInfo2));

  const ws = new WebSocket(`ws://localhost:${PORT}/ws?roomId=${roomId}&participantId=${create.participant.id}&token=${create.token}`);
  const msgs = [];
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); msgs.push(m); console.log('RECV:', m.type, m.payload ? JSON.stringify(m.payload).slice(0, 120) : ''); });
  ws.on('close', (code, reason) => console.log('WS CLOSED:', code, reason.toString()));
  ws.on('error', (e) => console.log('WS ERROR:', e.message));
  await new Promise((res, rej) => { ws.on('open', () => { console.log('WS OPEN'); res(); }); ws.on('error', rej); });
  await sleep(500);

  ws.send(JSON.stringify({ type: 'caption:event', payload: { speakerId: 'mock-1', text: 'The roadmap is not a wishlist, it is a commitment to the whole team today.', isFinal: true } }));
  await sleep(1500);
  console.log('--- after caption send ---');
  console.log('total msgs:', msgs.length);
  ws.close();
  process.exit(0);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
