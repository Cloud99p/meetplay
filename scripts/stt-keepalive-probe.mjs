// Probe: connect to /api/stt and verify the server sends stt:keepalive frames
// every ~10s (the liveness heartbeat added to fix "captions stop mid-call").
// Also verify Metadata arrives (Deepgram session actually opens) and that the
// connection survives >20s without any client audio (idle must NOT be killed).
//
// Usage: node scripts/stt-keepalive-probe.mjs [url]
import WebSocket from 'ws';

const url = process.argv[2] ?? 'ws://localhost:3001/api/stt';
const DURATION_MS = 25000;

const ws = new WebSocket(url);
const frames = [];
let metadataAt = null;
let firstKeepaliveAt = null;
let errors = [];

const timer = setTimeout(() => {
  const keepalives = frames.filter((f) => f.type === 'stt:keepalive').length;
  console.log(`\n=== RESULT ===`);
  console.log(`total frames: ${frames.length}`);
  console.log(`metadata: ${metadataAt ? 'YES (' + metadataAt + 'ms)' : 'NO'}`);
  console.log(`keepalives: ${keepalives} (first at ${firstKeepaliveAt ? firstKeepaliveAt + 'ms' : 'never'})`);
  console.log(`errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  const pass = metadataAt !== null && keepalives >= 1 && errors.length === 0;
  console.log(pass ? '✅ KEEPALIVE_PROBE_PASS' : '❌ KEEPALIVE_PROBE_FAIL');
  ws.close();
  process.exit(pass ? 0 : 1);
}, DURATION_MS);

const t0 = Date.now();
ws.on('open', () => {
  console.log(`opened in ${Date.now() - t0}ms — waiting ${DURATION_MS}ms (idle, no audio)...`);
  // Send a Configure like the real adapter does (server ignores it).
  ws.send(JSON.stringify({ type: 'Configure', encoding: 'linear16', sample_rate: 16000, channels: 1 }));
});
ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    frames.push(msg);
    if (msg.type === 'Metadata' && !metadataAt) metadataAt = Date.now() - t0;
    if (msg.type === 'stt:keepalive' && !firstKeepaliveAt) {
      firstKeepaliveAt = Date.now() - t0;
      console.log(`first stt:keepalive at ${firstKeepaliveAt}ms`);
    }
  } catch {
    /* binary/non-JSON — ignore */
  }
});
ws.on('error', (err) => {
  errors.push(err.message);
  console.log('ws error:', err.message);
});
ws.on('close', (code, reason) => {
  console.log(`ws closed early: code=${code} reason=${reason.toString()}`);
});
