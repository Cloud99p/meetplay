/**
 * Verifies raise-hand end to end over the real WebSocket.
 *
 * The bug: the server always broadcast hand:raised / hand:lowered, but nothing on
 * the client listened, had no state to render, and the button only ever sent
 * "raise" — so the feature was invisible and could not be undone. Fixing that added
 * server-side hand tracking, and tracking has its own failure mode worth locking
 * down: a snapshot that reports "no hands" would silently clear a raised hand on
 * every resync or late join.
 *
 * Asserts:
 *   1. hand:raise is broadcast to the room
 *   2. a LATE JOINER's initial room:state shows the hand as raised (server-tracked)
 *   3. hand:lower clears it, for the room and for a later snapshot
 *   4. a hand does not survive its owner leaving
 *
 * Usage (from the repo root):
 *   node scripts/verify-hand-raise.mjs
 */

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3226;
const BASE = `http://localhost:${PORT}`;
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const server = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    USE_MEMORY_DB: '1',
    DATABASE_URL: '',
    PORT: String(PORT),
    JWT_SECRET: '***',
    LIVEKIT_URL: '',
    LIVEKIT_API_KEY: '',
    LIVEKIT_API_SECRET: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

function socket(roomId, participantId, token) {
  // Built with URLSearchParams: string-interpolating a JWT into a URL is how this
  // file previously produced an invalid token and a silent, rejected socket.
  const url = new URL(`ws://localhost:${PORT}/ws`);
  url.searchParams.set('roomId', roomId);
  url.searchParams.set('participantId', participantId);
  url.searchParams.set('token', token);
  const ws = new WebSocket(url);
  const inbox = [];
  /** Anything the socket did other than deliver a frame (closes, errors). */
  const events = [];
  ws.on('message', (raw) => {
    try {
      inbox.push(JSON.parse(raw.toString()));
    } catch {}
  });
  ws.on('close', (code, reason) => events.push(`close ${code} ${reason?.toString() ?? ''}`.trim()));
  ws.on('error', (e) => events.push(`error ${e?.message ?? e}`));
  const wait = async (pred, ms, label) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await sleep(100);
    }
    throw new Error(
      `timed out waiting for ${label} — frames: [${inbox.map((m) => m.type).join(', ')}] socket: [${events.join('; ')}]`,
    );
  };
  return { ws, inbox, wait, open: new Promise((r) => ws.on('open', r)) };
}

const handOf = (snapshot, participantId) =>
  (snapshot.payload?.participants ?? []).find((p) => p.id === participantId)?.handRaised;

let roomId = null;
let hostToken = null;

try {
  const start = Date.now();
  let up = false;
  while (Date.now() - start < 30000) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) {
        up = true;
        break;
      }
    } catch {}
    await sleep(250);
  }
  check('server boots', up);

  const created = await (
    await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'hand-raise-check', userId: 'hand-host' }),
    })
  ).json();
  roomId = created.room.id;
  hostToken = created.token;
  const hostId = created.participant.id;

  const joined = await (
    await fetch(`${BASE}/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantName: 'Hand Raiser', userId: 'hand-guest' }),
    })
  ).json();
  const guestId = joined.participant.id;

  const host = socket(roomId, hostId, hostToken);
  const guest = socket(roomId, guestId, joined.token);
  await Promise.all([host.open, guest.open]);
  const initial = await host.wait((m) => m.type === 'room:state', 8000, 'initial state');
  check('hands start down', handOf(initial, guestId) === false, `handRaised=${handOf(initial, guestId)}`);

  // ─── raise ───────────────────────────────────────────────────────────────
  guest.ws.send(JSON.stringify({ type: 'hand:raise', payload: {} }));
  const raised = await host.wait(
    (m) => m.type === 'hand:raised' && m.payload?.participantId === guestId,
    5000,
    'hand:raised broadcast',
  );
  check('hand:raise is broadcast to the room', Boolean(raised));

  // A participant joining NOW must see the hand — the server has to be tracking it.
  const late = await (
    await fetch(`${BASE}/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantName: 'Late Joiner', userId: 'hand-late' }),
    })
  ).json();
  const lateSock = socket(roomId, late.participant.id, late.token);
  await lateSock.open;
  const lateState = await lateSock.wait((m) => m.type === 'room:state', 8000, 'late joiner state');
  check(
    'a late joiner sees the hand as raised',
    handOf(lateState, guestId) === true,
    `handRaised=${handOf(lateState, guestId)}`,
  );
  check(
    'the late joiner\'s own hand is down',
    handOf(lateState, late.participant.id) === false,
  );

  // ─── lower ───────────────────────────────────────────────────────────────
  guest.ws.send(JSON.stringify({ type: 'hand:lower', payload: {} }));
  const lowered = await host.wait(
    (m) => m.type === 'hand:lowered' && m.payload?.participantId === guestId,
    5000,
    'hand:lowered broadcast',
  );
  check('hand:lower is broadcast', Boolean(lowered));

  const late2 = await (
    await fetch(`${BASE}/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantName: 'Late Two', userId: 'hand-late-2' }),
    })
  ).json();
  const late2Sock = socket(roomId, late2.participant.id, late2.token);
  await late2Sock.open;
  const late2State = await late2Sock.wait((m) => m.type === 'room:state', 8000, 'snapshot after lowering');
  check(
    'lowering clears it for later snapshots',
    handOf(late2State, guestId) === false,
    `handRaised=${handOf(late2State, guestId)}`,
  );

  // ─── leaving drops the hand ──────────────────────────────────────────────
  guest.ws.send(JSON.stringify({ type: 'hand:raise', payload: {} }));
  await host.wait(
    (m) => m.type === 'hand:raised' && m.payload?.participantId === guestId,
    5000,
    'second raise',
  );
  guest.ws.close();
  await sleep(700);

  const late3 = await (
    await fetch(`${BASE}/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantName: 'Late Three', userId: 'hand-late-3' }),
    })
  ).json();
  const late3Sock = socket(roomId, late3.participant.id, late3.token);
  await late3Sock.open;
  const late3State = await late3Sock.wait((m) => m.type === 'room:state', 8000, 'snapshot after leaving');
  check(
    'a raised hand does not outlive its owner',
    handOf(late3State, guestId) === false,
    `handRaised=${handOf(late3State, guestId)}`,
  );

  host.ws.close();
  lateSock.ws.close();
  late2Sock.ws.close();
  late3Sock.ws.close();
} catch (e) {
  console.error('\nAborted:', e?.message ?? e);
  failures++;
} finally {
  if (roomId && hostToken) {
    try {
      await fetch(`${BASE}/api/rooms/${roomId}/end`, {
        method: 'POST',
        headers: { authorization: `***}` },
      });
    } catch {}
  }
  server.kill('SIGTERM');
  await sleep(400);
  server.kill('SIGKILL');
}

if (failures > 0) {
  console.log('\n--- server log tail ---');
  console.log(log.split('\n').slice(-15).join('\n'));
}
console.log(failures === 0 ? '\nRaise hand round-trips, and survives a resync.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
