// Self-contained smoke test: spawns the server, exercises API + WS, kills only its own child.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3210;
const BASE = `http://localhost:${PORT}`;
const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const server = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, USE_MEMORY_DB: '1', PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const waitForHealth = async (timeoutMs = 20000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  ok('server boots', await waitForHealth());

  // 1. Create room
  const createRes = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostName: 'TestHost' }),
  });
  const room = await createRes.json();
  ok('create room', createRes.ok && !!room.room?.id, `id=${room.room?.id}`);
  const roomId = room.room?.id;

  // 2. Join (get participant token) — try the documented route shape
  const joinRes = await fetch(`${BASE}/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantName: 'Alice' }),
  });
  const join = await joinRes.json();
  ok('join room', joinRes.ok && !!join.participant?.id, `pId=${join.participant?.id}`);

  // 3. WS round trip: two clients, chat + emoji broadcast
  const wsUrl = `ws://localhost:${PORT}/ws?roomId=${roomId}&participantId=${join.participant?.id}`;
  const alice = new WebSocket(wsUrl);
  const aliceMsgs = [];
  const bob = new WebSocket(wsUrl + `&participantId=${room.room?.hostId}`);
  const bobMsgs = [];

  const wsReady = (ws) => new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  await Promise.all([wsReady(alice), wsReady(bob)]);
  ok('WS connects (both clients)', true);

  alice.on('message', (d) => aliceMsgs.push(JSON.parse(d.toString())));
  bob.on('message', (d) => bobMsgs.push(JSON.parse(d.toString())));

  // chat send
  alice.send(JSON.stringify({ type: 'chat:send', payload: { content: 'hello from alice' } }));
  await sleep(700);
  ok('chat broadcast received', bobMsgs.some((m) => m.type === 'chat:received' && m.payload?.content === 'hello from alice'));

  // emoji send
  alice.send(JSON.stringify({ type: 'emoji:send', payload: { emoji: '🎉' } }));
  await sleep(700);
  const emojiMsg = bobMsgs.find((m) => m.type === 'emoji:received');
  ok('emoji broadcast received', !!emojiMsg, emojiMsg ? `emoji=${emojiMsg.payload?.emoji} name=${emojiMsg.payload?.participantName}` : 'none');

  // 4. room state via WS
  alice.send(JSON.stringify({ type: 'room:state' }));
  await sleep(700);
  ok('room:state returned', aliceMsgs.some((m) => m.type === 'room:state' && Array.isArray(m.payload?.participants)));

  alice.close();
  bob.close();
} catch (e) {
  ok('test run completed', false, e.message);
} finally {
  // Kill ONLY the spawned server child
  server.kill('SIGTERM');
  await sleep(500);
  if (server.exitCode === null) server.kill('SIGKILL');
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    console.log('Server log tail:\n' + serverLog.slice(-1500));
    process.exit(1);
  }
  process.exit(0);
}