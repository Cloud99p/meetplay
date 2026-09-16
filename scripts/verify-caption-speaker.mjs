/**
 * Regression test for the production caption bug.
 *
 * THE BUG: the browser STT adapters tag every utterance with a synthetic
 * speaker id — WebSpeech sends 'local', Deepgram diarization sends 'speaker-0',
 * Flux sends 'unknown'. The caption handler looked that id up in the database to
 * resolve a name. The in-memory store (dev) accepts any string key, so it quietly
 * fell through to "attribute to sender" and everything looked fine. Postgres does
 * not: the lookup threw
 *
 *   invalid input syntax for type uuid: "local"   (SQLSTATE 22P02)
 *
 * inside the caption handler, which aborted it BEFORE the broadcast, the
 * transcript row and the game-engine feed. Every utterance failed that way, so
 * captions never reached other participants and nothing was ever persisted.
 *
 * This test runs the REAL server against the REAL Postgres and sends exactly
 * what the adapter sends, then asserts the caption survived:
 *   1. a caption:event with speakerId 'local' is broadcast back, attributed to
 *      the sender's participant id (not 'local')
 *   2. the transcript row is actually written
 *   3. the same holds for a diarization-style 'speaker-0'
 *   4. a malformed participantId in the WS query is refused cleanly (close 4000),
 *      not with a database error
 *
 * Run (needs a local Postgres, see npm run db:up):
 *   node scripts/verify-caption-speaker.mjs
 */

import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import pg from 'pg';

const PORT = 3213;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.TEST_DATABASE_URL ?? 'postgres://meetplay:testpass@localhost:55432/caption_check';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pool = new pg.Pool({ connectionString: DB, max: 2, ssl: false });

const server = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    USE_MEMORY_DB: '0',
    DATABASE_URL: DB,
    DATABASE_SSL: 'disable',
    JWT_SECRET: 'caption-test-secret',
    PORT: String(PORT),
    LIVEKIT_URL: '',
    LIVEKIT_API_KEY: '',
    LIVEKIT_API_SECRET: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const waitForHealth = async (timeoutMs = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {}
    await sleep(300);
  }
  return false;
};

let roomId = null;

try {
  check('server boots against Postgres', await waitForHealth());

  const createRes = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'caption-speaker-check' }),
  });
  const created = await createRes.json();
  roomId = created?.room?.id;
  const hostId = created?.participant?.id;
  check('room + host created', Boolean(roomId && hostId), roomId ?? '');

  const wsUrl = `ws://localhost:${PORT}/ws?roomId=${roomId}&participantId=${hostId}&token=${created.token}`;
  const ws = new WebSocket(wsUrl);
  const inbox = [];
  ws.on('message', (raw) => {
    try {
      inbox.push(JSON.parse(raw.toString()));
    } catch {}
  });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  check('host WebSocket connected', true);

  const captions = (speakerId) => {
    ws.send(
      JSON.stringify({
        type: 'caption:event',
        payload: { speakerId, text: `hello from ${speakerId}`, isFinal: true, confidence: 0.95 },
      }),
    );
  };
  const waitCaption = async (text, timeoutMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = inbox.find((m) => m.type === 'caption:event' && m.payload?.text === text);
      if (hit) return hit;
      await sleep(150);
    }
    return null;
  };

  // ─── 1. The exact payload the browser adapters send ─────────────────────
  captions('local');
  const got = await waitCaption('hello from local');
  check('caption with speakerId="local" is broadcast', Boolean(got));
  check(
    'it is attributed to the real sender, not "local"',
    got?.payload?.speakerId === hostId,
    `speakerId=${got?.payload?.speakerId}`,
  );

  // ─── 2. It reached the database ─────────────────────────────────────────
  await sleep(500);
  const { rows } = await pool.query(
    'select participant_id, text from transcript_events where room_id = $1',
    [roomId],
  );
  check('transcript row persisted', rows.length === 1, `rows=${rows.length}`);
  check(
    'transcript row belongs to the real participant',
    rows[0]?.participant_id === hostId,
    String(rows[0]?.participant_id),
  );

  // ─── 3. Diarization-style ids behave the same way ───────────────────────
  captions('speaker-0');
  const got2 = await waitCaption('hello from speaker-0');
  check('caption with speakerId="speaker-0" is broadcast', Boolean(got2));
  check('and is attributed to the sender', got2?.payload?.speakerId === hostId);

  // ─── 4. Server log stays clean ──────────────────────────────────────────
  check(
    'no 22P02 uuid errors in the server log',
    !serverLog.includes('invalid input syntax for type uuid'),
  );

  ws.close();

  // ─── 5. A malformed participant id is refused before any query ──────────
  const bad = new WebSocket(`ws://localhost:${PORT}/ws?roomId=${roomId}&participantId=local&token=x`);
  const closeCode = await new Promise((res) => {
    bad.on('close', (code) => res(code));
    bad.on('error', () => res('error'));
    setTimeout(() => res('timeout'), 4000);
  });
  check('malformed participantId → clean close 4000/4001', closeCode === 4000 || closeCode === 4001, `code=${closeCode}`);
} catch (e) {
  console.error('\nAborted:', e?.message ?? e);
  failures++;
} finally {
  server.kill('SIGTERM');
  await sleep(500);
  server.kill('SIGKILL');
  if (roomId) {
    try {
      await pool.query('delete from rooms where id = $1', [roomId]);
    } catch {}
  }
  await pool.end();
}

if (failures > 0) {
  console.log('\n--- server log tail ---');
  console.log(serverLog.split('\n').slice(-25).join('\n'));
}
console.log(failures === 0 ? '\nCaption pipeline is healthy on Postgres.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
