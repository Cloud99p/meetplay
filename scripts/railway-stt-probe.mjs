// Probe the LIVE Railway deployment: does wss://meetplay-production.up.railway.app/api/stt
// accept a WebSocket upgrade and establish a Deepgram session?
// Usage: node scripts/railway-stt-probe.mjs
const WS_URL = process.env.STT_URL || 'wss://meetplay-production.up.railway.app/api/stt';

const ws = new WebSocket(WS_URL);
const timeout = setTimeout(() => {
  console.error(`TIMEOUT: no response from ${WS_URL} in 15s — upgrade likely blocked`);
  ws.close();
  process.exit(1);
}, 15000);

let sawMetadata = false;
let sawResults = false;

ws.onopen = () => {
  console.log('✅ WS OPEN:', WS_URL);
  ws.send(
    JSON.stringify({
      type: 'Configure',
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      model: 'nova-2',
      diarize: true,
      interim_results: true,
      punctuate: true,
    }),
  );
  console.log('   Configure sent');
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  console.log('   <-', msg.type, msg.message ? `(${msg.message})` : '');
  if (msg.type === 'Metadata') sawMetadata = true;
  if (msg.type === 'Results') sawResults = true;
  if (msg.type === 'Error') {
    console.error('❌ SERVER ERROR:', msg.message);
    clearTimeout(timeout);
    ws.close();
    process.exit(1);
  }
  if (sawMetadata) {
    console.log('✅ Deepgram session established on Railway (Metadata received)');
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  }
};

ws.onerror = (e) => {
  console.error('❌ WS ERROR:', e.message || e);
  clearTimeout(timeout);
  process.exit(1);
};

ws.onclose = (e) => {
  if (!sawMetadata) {
    console.error(`❌ WS CLOSED before Metadata: code=${e.code} reason=${e.reason}`);
    clearTimeout(timeout);
    process.exit(1);
  }
};
