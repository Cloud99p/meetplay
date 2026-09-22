/**
 * Verifies the WebSocket message limits.
 *
 * Bug this locks down: the hub is one process serving every room, and the socket
 * path had NO metering at all (REST was capped at 120/min, WS was unlimited), so a
 * single client could flood frames and degrade every call in the process.
 *
 * Normal traffic must pass untouched — this is flood protection, not throttling of
 * real use — and a flood must be dropped, announced, then disconnected.
 *
 * Usage (from the repo root):
 *   node scripts/verify-ws-limits.mjs
 */

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3224;
const BASE = `http://localhost:${PORT}`;
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
};

async function withServer(extraEnv, fn) {
  const child = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      USE_MEMORY_DB: '1',
      DATABASE_URL: '',
      PORT: String(PORT),
      JWT_SECRET: 'ws-limits-secret',
      LIVEKIT_URL: '',
      LIVEKIT_API_KEY: '',
      LIVEKIT_API_SECRET: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  try {
    const start = Date.now();
    while (Date.now() - start < 30000) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break;
      } catch {}
      await sleep(250);
    }
    return await fn(() => log);
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    child.kill('SIGKILL');
  }
}

async function newRoomWithSocket() {
  const created = await (
    await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ws-limit-probe', userId: 'ws-probe-user' }),
    })
  ).json();
  const ws = new WebSocket(
    `ws://localhost:${PORT}/ws?roomId=${created.room.id}&participantId=${created.participant.id}&token=${created.token}`,
  );
  const inbox = [];
  let close = null;
  ws.on('message', (raw) => {
    try {
      inbox.push(JSON.parse(raw.toString()));
    } catch {}
  });
  ws.on('close', (code, reason) => (close = { code, reason: reason?.toString() ?? '' }));
  ws.on('error', () => {});
  await new Promise((res) => {
    ws.on('open', () => res());
    setTimeout(res, 3000);
  });
  await sleep(600);
  return { ws, inbox, getClose: () => close };
}

console.log('WebSocket message limits\n');

// ─── A. Real traffic is not throttled ───────────────────────────────────────
await withServer({}, async () => {
  const { ws, inbox } = await newRoomWithSocket();
  const sent = 6;
  for (let i = 0; i < sent; i++) ws.send(JSON.stringify({ type: 'chat:send', payload: { content: `hello ${i}` } }));
  await sleep(1200);
  const echoed = inbox.filter((m) => m.type === 'chat:received').length;
  check('normal traffic passes untouched', echoed === sent, `${echoed}/${sent} echoed`);
  check('no rate-limit warning for real use', !inbox.some((m) => m.type === 'rate:limited'));
  ws.close();
});

// ─── B. A flood is dropped, announced, then disconnected ────────────────────
await withServer({}, async (getLog) => {
  const { ws, inbox, getClose } = await newRoomWithSocket();
  const total = 400;
  for (let i = 0; i < total; i++) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(JSON.stringify({ type: 'chat:send', payload: { content: `flood ${i}` } }));
  }
  await sleep(2500);
  const echoed = inbox.filter((m) => m.type === 'chat:received').length;
  check('flood is dropped rather than dispatched', echoed < total, `${echoed}/${total} echoed`);
  check('sender is told, once', inbox.some((m) => m.type === 'rate:limited'));
  check('sustained flooding closes the socket', getClose()?.code === 1008, `code=${getClose()?.code} reason=${getClose()?.reason}`);
  check('server logs the limit', /message rate limit hit/.test(getLog()));
});

// ─── C. Limits are tunable without a deploy ─────────────────────────────────
await withServer({ WS_MSG_BURST: '2', WS_MSG_PER_SEC: '1', WS_MSG_STRIKE_LIMIT: '1' }, async () => {
  const { ws, inbox, getClose } = await newRoomWithSocket();
  for (let i = 0; i < 30; i++) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(JSON.stringify({ type: 'chat:send', payload: { content: `tight ${i}` } }));
  }
  await sleep(2000);
  check('tighter limits take effect (env knobs work)', getClose()?.code === 1008, `code=${getClose()?.code}`);
  check('and the client is still told first', inbox.some((m) => m.type === 'rate:limited'));
});

console.log(failures === 0 ? '\nWS message limits hold.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
