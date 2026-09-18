/**
 * Verifies the /api/stt abuse + cost guards.
 *
 * Why these exist: the caption relay proxies a credentialed Deepgram session and
 * intentionally requires no account (students must not have to log in to be
 * captioned). That openness is also the risk — anyone who can reach the URL can
 * spend the project's credits — so the server caps concurrency, wall-clock and
 * bytes, and can be switched off globally without a deploy (STT_ENABLED=0).
 *
 * Each case boots the real server with one guard set tight, then drives it over
 * a real WebSocket. No audio is streamed except in the size case, so the run
 * costs effectively nothing.
 *
 * Usage (from the repo root):
 *   node --env-file=.env scripts/verify-stt-guards.mjs
 *   -> without DEEPGRAM_API_KEY, only the pre-upstream refusals are exercised.
 */

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3215;
const BASE = `http://localhost:${PORT}`;
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Boot the server with extra env, run `fn`, always tear down. */
async function withServer(extraEnv, fn) {
  const server = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      USE_MEMORY_DB: '1',
      PORT: String(PORT),
      JWT_SECRET: 'stt-guard-test',
      LIVEKIT_URL: '',
      LIVEKIT_API_KEY: '',
      LIVEKIT_API_SECRET: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));

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
    if (!up) throw new Error('server did not boot');
    // Pass a getter, not the current string: the caller's assertions run after
    // more output has been written, and a captured value would be a snapshot.
    return await fn(() => log);
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    server.kill('SIGKILL');
  }
}

/** Open a caption socket and observe what the server does with it. */
async function openCaptionSocket({ keepOpenMs = 1500 } = {}) {
  const ws = new WebSocket(`ws://localhost:${PORT}/api/stt`);
  const frames = [];
  let close = null;
  ws.on('message', (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()));
    } catch {}
  });
  ws.on('close', (code, reason) => {
    close = { code, reason: reason?.toString() ?? '' };
  });
  ws.on('error', () => {});
  await new Promise((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', rej);
    setTimeout(() => res(), 2000);
  });
  await sleep(keepOpenMs);
  const errorFrame = frames.find((f) => f.type === 'Error');
  const result = { ws, frames, close, errorFrame };
  if (ws.readyState === WebSocket.OPEN) ws.close();
  await sleep(200);
  return result;
}

console.log('Caption relay guards\n');

// ─── 1. Kill switch: STT_ENABLED=0 refuses before any upstream connection ────
await withServer({ STT_ENABLED: '0' }, async (getLog) => {
  const r = await openCaptionSocket();
  check('kill switch sends an explanation, not a silent close', Boolean(r.errorFrame),
    r.errorFrame?.code ?? 'no frame');
  check('kill switch refuses with STT_DISABLED', r.errorFrame?.code === 'STT_DISABLED');
  check('kill switch closes 1013 (so the client stops retrying)', r.close?.code === 1013,
    `code=${r.close?.code}`);
  check('refusal is logged server-side', /refused: caption relay disabled/i.test(getLog()));
});

// ─── 2. Wall-clock cap: a 2s limit closes a live session with 1008 ──────────
if (!process.env.DEEPGRAM_API_KEY) {
  console.log('SKIP  session/timeout caps need DEEPGRAM_API_KEY (no upstream without it)');
} else {
  await withServer({ STT_MAX_SESSION_SECONDS: '2' }, async (getLog) => {
    const r = await openCaptionSocket({ keepOpenMs: 3500 });
    check('time cap closes the session', r.close?.code === 1008, `code=${r.close?.code}`);
    check('time cap explains itself', r.errorFrame?.code === 'STT_SESSION_LIMIT',
      r.errorFrame?.code ?? 'no frame');
    check('time cap is logged', /session limit reached/i.test(getLog()));
  });

  // ─── 3. Per-IP cap: one session allowed, the second refused ──────────────
  await withServer({ STT_MAX_PER_IP: '1' }, async (getLog) => {
    const first = new WebSocket(`ws://localhost:${PORT}/api/stt`);
    await new Promise((res) => {
      first.on('open', () => res());
      first.on('error', () => res());
    });
    await sleep(800);
    const second = await openCaptionSocket();
    check('second session from the same address is refused',
      second.errorFrame?.code === 'STT_IP_LIMIT', second.errorFrame?.code ?? 'no frame');
    check('per-IP refusal is logged', /STT_MAX_PER_IP/.test(getLog()));
    first.close();
  });

  // ─── 4. Concurrency cap: refuse when the server is full ──────────────────
  await withServer({ STT_MAX_CONCURRENT: '0' }, async () => {
    const r = await openCaptionSocket();
    check('server at capacity refuses with STT_BUSY', r.errorFrame?.code === 'STT_BUSY',
      r.errorFrame?.code ?? 'no frame');
    check('capacity refusal closes 1013', r.close?.code === 1013, `code=${r.close?.code}`);
  });

  // ─── 5. Byte cap: a tiny limit trips on the first audio chunk ────────────
  await withServer({ STT_MAX_AUDIO_BYTES: '1000' }, async (getLog) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/api/stt`);
    const frames = [];
    let close = null;
    ws.on('message', (raw) => {
      try {
        frames.push(JSON.parse(raw.toString()));
      } catch {}
    });
    ws.on('close', (code) => {
      close = code;
    });
    ws.on('error', () => {});
    await new Promise((res) => {
      ws.on('open', () => res());
      ws.on('error', () => res());
      setTimeout(() => res(), 2000);
    });
    await sleep(600);
    ws.send(Buffer.alloc(3200)); // 100 ms of PCM16 — over the 1000-byte cap
    await sleep(1200);
    check('byte cap closes the session', close === 1008, `code=${close}`);
    check('byte cap is logged', /audio cap reached/i.test(getLog()));
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });
}

console.log(failures === 0 ? '\nCaption relay guards hold.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
