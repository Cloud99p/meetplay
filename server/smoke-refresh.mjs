// Reproduces a page-refresh rejoin: host creates room, connects WS,
// then "refreshes" = new WS connection with SAME userId (what the client's
// resumeSession does via POST /api/rooms/:id/join). Verifies the server
// reuses the participant row and sends a full room:state.
import WebSocket from 'ws';

const BASE = 'http://localhost:3999';
const WS_BASE = 'ws://localhost:3999';
const USER_ID = 'test-user-refresh-123';

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

// 1. Create room as host (with userId)
const room = await api('/api/rooms', {
  method: 'POST',
  body: JSON.stringify({ name: 'refresh test', userId: USER_ID }),
});
const roomId = room.json.room?.id ?? room.json.id;
const hostToken = room.json.token;
console.log('room:', roomId);
console.log('host participant:', room.json.participant?.id, 'isHost:', room.json.participant?.isHost);

// 2. First connection (simulates initial join)
const ws1 = await connectWs(roomId, room.json.participant.id, hostToken);
console.log('first connect: room:state received, transcriptionEnabled =', ws1.roomState.transcriptionEnabled);

// 3. "Refresh": same userId joins again via the join endpoint (what resumeSession does)
const rejoin = await api(`/api/rooms/${roomId}/join`, {
  method: 'POST',
  body: JSON.stringify({ participantName: room.json.participant.name, userId: USER_ID }),
});
console.log('rejoin status:', rejoin.status);
console.log('rejoin participant:', rejoin.json.participant?.id, 'same id:', rejoin.json.participant?.id === room.json.participant.id, 'isHost:', rejoin.json.participant?.isHost);
console.log('room state on rejoin:', rejoin.json.room?.state);

// 4. New WS with the rejoin token — must get a full room:state
const ws2 = await connectWs(roomId, rejoin.json.participant.id, rejoin.json.token);
console.log('second connect: room:state received');
const types2 = [...new Set(ws2.events.map((e) => e.type))];
console.log('events on reconnect:', types2.join(', '));
console.log('state has market?', ws2.roomState.market ? 'yes' : 'no');
console.log('state has bingo?', ws2.roomState.bingo ? 'yes' : 'no');
console.log('state transcriptionEnabled:', ws2.roomState.transcriptionEnabled);

ws1.close();
ws2.close();
console.log('REFRESH REJOIN TEST DONE');
process.exit(0);
