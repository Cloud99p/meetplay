// Focused regression test: host toggles transcription via HTTP AFTER the WS
// connection is live (the exact flow the UI button uses). The server must
// broadcast `transcript:toggled` so the client state flips.
// Previously this broadcast was missing → button "did nothing".
import WebSocket from 'ws';

const BASE = 'http://localhost:3999';
const WS_BASE = 'ws://localhost:3999';

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    ...opts,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function connectWs(roomId, participantId, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?roomId=${roomId}&participantId=${participantId}&token=${token}`);
    ws.events = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.events.push(msg);
      if (msg.type === 'room:state') {
        ws.roomState = msg.payload;
        resolve(ws);
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('room:state timeout')), 5000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Create room (host)
const room = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'toggle test' }) });
const roomId = room.json.room?.id ?? room.json.id;
const hostToken = room.json.token ?? room.json.roomToken;
if (!roomId || !hostToken) {
  console.error('room create failed:', JSON.stringify(room.json));
  process.exit(1);
}
console.log('room:', roomId);

// 2. Host connects WS (transcription default OFF)
const host = await connectWs(roomId, room.json.participant?.id, hostToken);
console.log('initial transcriptionEnabled:', host.roomState.transcriptionEnabled);

// 3. Toggle ON via HTTP (exactly what the UI button does)
const t = await api(`/api/rooms/${roomId}/transcript/toggle`, {
  method: 'POST',
  token: hostToken,
  body: JSON.stringify({ enabled: true }),
});
console.log('toggle http status:', t.status, 'resp:', JSON.stringify(t.json));

// 4. Wait for the broadcast → this is the regression check
await sleep(800);
const toggled = host.events.filter((e) => e.type === 'transcript:toggled');
console.log('transcript:toggled received:', toggled.length, toggled.length ? JSON.stringify(toggled.map((e) => e.payload)) : 'FAIL');
const state = host.events.filter((e) => e.type === 'room:state');
console.log('room:state after toggle count:', state.length, state.length ? `transcriptionEnabled=${state[state.length - 1].payload.transcriptionEnabled}` : '');

// 5. Toggle OFF again (both directions)
const t2 = await api(`/api/rooms/${roomId}/transcript/toggle`, {
  method: 'POST',
  token: hostToken,
  body: JSON.stringify({ enabled: false }),
});
await sleep(800);
const toggledOff = host.events.filter((e) => e.type === 'transcript:toggled');
console.log('toggle off http status:', t2.status, '| transcript:toggled count:', toggledOff.length, '| last payload:', JSON.stringify(toggledOff[toggledOff.length - 1]?.payload));

// 6. Non-host must be REJECTED (403)
const guestRoom = await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: JSON.stringify({ name: 'guest' }) });
const guestToken = guestRoom.json.token;
const g = await api(`/api/rooms/${roomId}/transcript/toggle`, { method: 'POST', token: guestToken, body: JSON.stringify({ enabled: true }) });
console.log('non-host toggle status (expect 403):', g.status);

const lastToggled = toggledOff[toggledOff.length - 1];
const passed =
  toggled.length >= 1 &&
  toggled[0]?.payload?.enabled === true &&
  toggledOff.length >= 2 &&
  lastToggled?.payload?.enabled === false &&
  t.status === 200 &&
  t2.status === 200 &&
  g.status === 403;
console.log(passed ? 'TOGGLE TEST PASSED' : 'TOGGLE TEST FAILED');
process.exit(passed ? 0 : 1);
