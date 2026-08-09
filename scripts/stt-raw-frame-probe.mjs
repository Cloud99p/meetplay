// Raw probe: stream fake audio to Railway /api/stt and print EVERY frame
// verbatim (especially Error frames) so we can see what Deepgram/Flux sends.
import WebSocket from 'ws';

const url = process.argv[2] ?? 'wss://meetplay-production.up.railway.app/api/stt';
const DURATION_MS = 45000;

const ws = new WebSocket(url);
const t0 = Date.now();
let frames = 0;

const timer = setTimeout(() => {
  console.log(`\n=== DONE (${frames} frames in ${Date.now() - t0}ms) ===`);
  ws.close();
  process.exit(0);
}, DURATION_MS);

// 1 second of 440Hz sine-ish PCM16 at 16kHz, repeated — audible tone, not silence
const tone = Buffer.alloc(16000 * 2);
for (let i = 0; i < 16000; i++) {
  tone.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 8000), i * 2);
}

ws.on('open', () => {
  console.log(`opened in ${Date.now() - t0}ms`);
  ws.send(JSON.stringify({ type: 'Configure', encoding: 'linear16', sample_rate: 16000, channels: 1 }));
  const stream = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(tone);
  }, 200);
  setTimeout(() => clearInterval(stream), DURATION_MS - 2000);
});

ws.on('message', (data) => {
  frames++;
  const s = data.toString();
  let pretty = s;
  try {
    const j = JSON.parse(s);
    pretty = JSON.stringify(j).slice(0, 300);
  } catch { /* binary */ }
  console.log(`+${Date.now() - t0}ms FRAME: ${pretty}`);
});

ws.on('error', (e) => console.log('ws error:', e.message));
ws.on('close', (code, reason) => console.log(`closed: ${code} ${reason}`));
