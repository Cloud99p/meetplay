/**
 * Live check of the server-side Deepgram proxy — no browser, real credentials.
 *
 * Why: captions are the product's main feature and the proxy has already broken
 * twice in ways only the wire reveals. The one this test was written for: the
 * proxy sent a v1 `{"type":"KeepAlive"}` on the Flux (v2) endpoint every 30s.
 * Flux accepts only CloseStream / ForceEndTurn / Configure, so Deepgram answered
 *
 *   {"type":"Error","code":"UNPARSABLE_CLIENT_MESSAGE", ...}
 *
 * which the proxy relayed to the browser as a scary "server error" — and which
 * risks the session being closed as malformed. Silence in the log is the pass
 * condition here, so the run must outlast the 30s keepalive window.
 *
 * It also proves, end to end: the key works, the upstream handshake succeeds,
 * and protocol traffic flows after the keepalive boundary.
 *
 * Usage (needs DEEPGRAM_API_KEY, e.g. via --env-file=.env):
 *   node --env-file=.env scripts/verify-stt-proxy.mjs [seconds]
 */

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3214;
const SECONDS = Number(process.argv[2] ?? 35);

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.DEEPGRAM_API_KEY) {
  console.error('DEEPGRAM_API_KEY is not set (use --env-file=.env)');
  process.exit(1);
}

const server = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    USE_MEMORY_DB: '1',
    PORT: String(PORT),
    JWT_SECRET: 'stt-test-secret',
    LIVEKIT_URL: '',
    LIVEKIT_API_KEY: '',
    LIVEKIT_API_SECRET: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

try {
  // Wait for boot.
  const start = Date.now();
  let up = false;
  while (Date.now() - start < 30000) {
    try {
      if ((await fetch(`http://localhost:${PORT}/health`)).ok) {
        up = true;
        break;
      }
    } catch {}
    await sleep(300);
  }
  check('server boots', up);

  const model = 'pending';
  const ws = new WebSocket(`ws://localhost:${PORT}/api/stt`);
  const frames = [];
  ws.on('message', (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()));
    } catch {}
  });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  await sleep(1500);
  const modelSeen = serverLog.match(/client connected \(model=([^)]+)\)/)?.[1];
  check(
    'upstream Deepgram session opened',
    Boolean(modelSeen) || serverLog.includes('upstream Deepgram OPEN'),
    `model=${modelSeen ?? 'unknown'}`,
  );

  // Stream 16 kHz mono PCM16 silence while we wait past the keepalive window.
  // (Digital silence keeps this test free of any audio content.)
  const chunk = Buffer.alloc(3200); // 100 ms @ 16 kHz s16le
  const ticker = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  }, 100);

  await sleep(SECONDS * 1000);
  clearInterval(ticker);
  ws.close();
  await sleep(500);

  const errors = frames.filter((f) => f.type === 'Error');
  const unparsable = errors.filter((f) => f.code === 'UNPARSABLE_CLIENT_MESSAGE');
  check(
    'no UNPARSABLE_CLIENT_MESSAGE from Deepgram',
    unparsable.length === 0,
    unparsable.length ? JSON.stringify(unparsable[0]) : `${errors.length} other error frame(s)`,
  );
  check('no other upstream error frames', errors.length === 0, JSON.stringify(errors.slice(0, 2)));
  check(
    'session outlived the 30s upstream-keepalive window',
    SECONDS >= 31,
    `ran ${SECONDS}s, audioBytes=${/audioBytes=(\d+)/.exec(serverLog)?.[1] ?? '?'}`,
  );
  check(
    'proxy never relayed a protocol complaint',
    !serverLog.includes('not relaying'),
  );

  const received = frames.filter((f) => f.type !== 'Metadata').length;
  console.log(`      frames received from upstream: ${frames.length} (${received} beyond Metadata)`);
} catch (e) {
  console.error('\nAborted:', e?.message ?? e);
  failures++;
} finally {
  server.kill('SIGTERM');
  await sleep(400);
  server.kill('SIGKILL');
}

if (failures > 0) {
  console.log('\n--- server log tail ---');
  console.log(serverLog.split('\n').slice(-30).join('\n'));
}
console.log(failures === 0 ? '\nSTT proxy is healthy.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
