/**
 * Regression test for the host-rights bug.
 *
 * THE BUG (reported by Cloud): when the host left the call, host rights were
 * handed to an arbitrary participant and were NOT returned when the host came
 * back — he stayed a normal participant for the life of the room.
 *
 * ROOT CAUSE: `promoteToHost()` ended with `setRoomHost(room_id, participantId)`,
 * so the interim promotion overwrote `rooms.host_participant_id`. That field is a
 * participant ROW id, and the rejoin "host heal" only looked at it — after the
 * overwrite it pointed at the interim host, so the owner could never be
 * recognised again. Ownership is now recorded as `rooms.host_user_id` (the
 * browser's stable localStorage id), an interim host is appointed WITHOUT
 * claiming ownership, and the owner's powers are restored on rejoin.
 *
 * Drives the real server over HTTP + WebSocket with a 1.2s promotion grace period.
 *
 * Usage (from the repo root):
 *   node scripts/verify-host-return.mjs
 */

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3218;
const BASE = `http://localhost:${PORT}`;
const OWNER = 'owner-user-id-' + Math.random().toString(36).slice(2, 8);
const GUEST = 'guest-user-id-' + Math.random().toString(36).slice(2, 8);

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}

function openSocket(roomId, participantId, token) {
  const ws = new WebSocket(
    `ws://localhost:${PORT}/ws?roomId=${roomId}&participantId=${participantId}&token=${encodeURIComponent(token)}`,
  );
  const inbox = [];
  ws.on('message', (raw) => {
    try {
      inbox.push(JSON.parse(raw.toString()));
    } catch {}
  });
  ws.on('error', () => {});
  const wait = async (predicate, timeoutMs, label) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = inbox.find(predicate);
      if (hit) return hit;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label} (saw: ${inbox.map((m) => m.type).join(', ')})`);
  };
  return { ws, inbox, wait, open: new Promise((res) => ws.on('open', res)) };
}

const server = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    USE_MEMORY_DB: '1',
    PORT: String(PORT),
    JWT_SECRET: '***',
    LIVEKIT_URL: '',
    LIVEKIT_API_KEY: '',
    LIVEKIT_API_SECRET: '',
    // The whole point of the env knob: a test can't wait 60s.
    HOST_PROMOTION_TIMEOUT_MS: '1200',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

let roomId = null;
let ownerToken = null;

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

  // ─── Owner creates the room ──────────────────────────────────────────────
  const created = await (
    await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'host-return-check', userId: OWNER }),
    })
  ).json();
  roomId = created.room.id;
  ownerToken = created.token;
  const ownerId = created.participant.id;
  check('owner creates the room as host', created.participant.isHost === true);

  // ─── A participant joins ─────────────────────────────────────────────────
  const joined = await (
    await fetch(`${BASE}/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantName: 'Guest', userId: GUEST }),
    })
  ).json();
  const guestId = joined.participant.id;
  const guestToken = joined.token;
  check('guest joins as a non-host', joined.participant.isHost === false);

  const owner = openSocket(roomId, ownerId, ownerToken);
  const guest = openSocket(roomId, guestId, guestToken);
  await Promise.all([owner.open, guest.open]);
  await owner.wait((m) => m.type === 'room:state', 5000, 'owner room state');

  // ─── Owner leaves (drops) → interim host after the grace period ──────────
  owner.ws.close();
  const promoted = await guest.wait(
    (m) => m.type === 'host:promoted' && m.payload?.participantId === guestId,
    8000,
    'interim promotion',
  );
  check('interim host appointed while the owner is away', Boolean(promoted));
  check(
    'promotion is logged as interim, not a handover',
    /interim host/i.test(log),
  );

  // ─── Owner rejoins with the same identity ────────────────────────────────
  const rejoin = await (
    await fetch(`${BASE}/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantName: 'Host', userId: OWNER }),
    })
  ).json();
  check(
    'THE FIX: rejoining owner gets host powers back',
    rejoin.participant.isHost === true,
    `isHost=${rejoin.participant.isHost}`,
  );
  check(
    'owner keeps the same participant row on rejoin',
    rejoin.participant.id === ownerId,
    `${rejoin.participant.id} vs ${ownerId}`,
  );

  // ─── The room agrees, and the interim host is told ───────────────────────
  const ownerAgain = openSocket(roomId, rejoin.participant.id, rejoin.token);
  await ownerAgain.open;
  const state = await ownerAgain.wait((m) => m.type === 'room:state', 5000, 'room state');
  const hosts = (state.payload?.participants ?? []).filter((p) => p.isHost);
  check(
    'exactly one host in the room, and it is the owner',
    hosts.length === 1 && hosts[0].id === rejoin.participant.id,
    hosts.map((h) => h.name).join(', ') || 'none',
  );

  const demoted = await guest.wait(
    (m) => m.type === 'host:promoted' && m.payload?.participantId === rejoin.participant.id,
    6000,
    'owner re-announced as host',
  );
  check('interim host is told the owner is back (so its UI drops host controls)', Boolean(demoted));

  ownerAgain.ws.close();
  guest.ws.close();
} catch (e) {
  console.error('\nAborted:', e?.message ?? e);
  failures++;
} finally {
  if (roomId && ownerToken) {
    try {
      await fetch(`${BASE}/api/rooms/${roomId}/end`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerToken}` },
      });
    } catch {}
  }
  server.kill('SIGTERM');
  await sleep(400);
  server.kill('SIGKILL');
}

if (failures > 0) {
  console.log('\n--- server log tail ---');
  console.log(log.split('\n').slice(-25).join('\n'));
}
console.log(failures === 0 ? '\nHost rights survive a leave/rejoin.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
