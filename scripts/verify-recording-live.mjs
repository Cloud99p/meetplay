/**
 * End-to-end recording check against a RUNNING deployment — the whole chain, no
 * browser: room → host WebSocket → recording:start → LiveKit egress → signed
 * playback URL → fetch the bytes → cleanup.
 *
 * Why this exists: the record button's state comes from the server's room-state
 * snapshot (`recordingAvailable` + reason). If the S3_* variables aren't set on
 * the deployment, the button is disabled with a reason — and that is invisible
 * from the outside. This script says which of the two it is, and then actually
 * exercises the path instead of trusting it.
 *
 * Usage (from the repo root):
 *   node --env-file=.env scripts/verify-recording-live.mjs https://your-app.example.com [seconds]
 *   ... --keep     leave the probe room in the database (default: delete it)
 *
 * Note: this consumes a few egress seconds on the LiveKit plan. Keep the
 * duration short outside a real test.
 */

import WebSocket from 'ws';
import pg from 'pg';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const keep = process.argv.includes('--keep');
const BASE = args[0] ?? 'http://localhost:3001';
const RECORD_SECONDS = Number(args[1] ?? 10);
const WS_BASE = BASE.replace(/^http/, 'ws');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Target: ${BASE}\n`);

let roomId = null;
let hostToken = null;

try {
  // ─── 1. Create a room (host participant + token come back) ────────────────
  const createRes = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `recording-check ${new Date().toISOString()}` }),
  });
  check('POST /api/rooms → 201', createRes.status === 201, `status=${createRes.status}`);
  const created = await createRes.json();
  roomId = created?.room?.id;
  hostToken = created?.token;
  check('room + host token returned', Boolean(roomId && hostToken), roomId ?? 'missing');
  if (!roomId || !hostToken) throw new Error('cannot continue without a room');

  // ─── 2. Host WebSocket ───────────────────────────────────────────────────
  const ws = new WebSocket(
    `${WS_BASE}/ws?roomId=${roomId}&participantId=${created.participant.id}&token=${hostToken}`,
  );
  const inbox = [];
  ws.on('message', (raw) => {
    try {
      inbox.push(JSON.parse(raw.toString()));
    } catch {
      /* ignore non-JSON */
    }
  });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  check('host WebSocket connected', true);

  const waitFor = async (predicate, timeoutMs, label) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = inbox.find(predicate);
      if (hit) return hit;
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${label} (got: ${inbox.map((m) => m.type).join(', ')})`);
  };
  const send = (type, payload = {}) => ws.send(JSON.stringify({ type, payload }));

  // ─── 3. Room state: is recording even available here? ────────────────────
  const state = await waitFor(
    (m) => m.type === 'room:state' || m.payload?.recordingAvailable !== undefined,
    8000,
    'room state snapshot',
  );
  const available = state.payload?.recordingAvailable ?? state.recordingAvailable;
  check('server reports recordingAvailable', available === true, String(available));
  if (available !== true) {
    console.log('\nThe deployed server says recording is unavailable — set the S3_* variables');
    console.log('(and RECORDING_ENABLED=1) on the deployment, then redeploy. Reason given by the server:');
    console.log('  ' + (state.payload?.recordingReason ?? state.payload?.reason ?? '(no reason reported)'));
    ws.close();
    throw new Error('recording not available on this deployment');
  }

  // ─── 4. Start recording ──────────────────────────────────────────────────
  send('recording:start', {});
  const started = await waitFor(
    (m) => m.type === 'recording:started' || m.type === 'recording:error',
    20000,
    'recording:started / recording:error',
  );
  check(
    'egress accepted the start request',
    started.type === 'recording:started',
    started.type === 'recording:error' ? started.payload?.message : 'started',
  );
  if (started.type !== 'recording:started') {
    ws.close();
    throw new Error('egress rejected the request');
  }

  // ─── 5. Record for a few seconds, then stop ──────────────────────────────
  await sleep(RECORD_SECONDS * 1000);
  inbox.length = 0;
  send('recording:stop', {});
  const stopped = await waitFor(
    (m) => m.type === 'recording:stopped' && m.payload?.downloadUrl !== undefined,
    40000,
    'recording:stopped with a URL',
  );
  const { downloadUrl, filename } = stopped.payload ?? {};
  check('stop returned an object key', Boolean(filename), filename ?? 'none');
  check('stop returned a playable URL', Boolean(downloadUrl), downloadUrl ? 'yes' : 'none');
  check(
    'URL is a signed link, not a public one',
    typeof downloadUrl === 'string' && downloadUrl.includes('X-Amz-Signature'),
  );
  if (downloadUrl) {
    const u = new URL(downloadUrl);
    console.log(`      host: ${u.host}`);
    console.log(`      path: ${u.pathname}`);
  }

  // ─── 6. Fetch it: is the recording real and readable? ────────────────────
  if (downloadUrl) {
    const res = await fetch(downloadUrl);
    check('signed URL fetches the recording', res.status === 200, `status=${res.status}`);
    const bytes = Number(res.headers.get('content-length') ?? 0);
    check('recording has content', bytes > 0, `${bytes} bytes`);
  }

  ws.close();
} catch (e) {
  console.error('\nAborted:', e?.message ?? e);
  failures++;
} finally {
  // ─── 7. Clean up the probe room (cascades to participants/recordings) ────
  const url = process.env.DATABASE_URL;
  if (roomId && url && !keep) {
    const useSsl = /localhost|127\.0\.0\.1/.test(url)
      ? false
      : { rejectUnauthorized: process.env.DATABASE_SSL === 'verify' };
    const pool = new pg.Pool({ connectionString: url, max: 1, ssl: useSsl });
    try {
      const { rowCount } = await pool.query('delete from rooms where id = $1', [roomId]);
      console.log(`\ncleaned up probe room ${roomId} (rows deleted: ${rowCount})`);
    } catch (e) {
      console.warn(`\ncould not clean up probe room ${roomId}: ${e.message}`);
    } finally {
      await pool.end();
    }
  } else if (roomId) {
    console.log(`\nprobe room kept: ${roomId}`);
  }
}

console.log(failures === 0 ? '\nRecording works end to end.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
