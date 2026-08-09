// Drive the LIVE Railway app with FAKE media devices (fake mic+camera) so the
// room fully loads in headless Chrome, then verify the full STT loop:
// WS /api/stt opens -> Configure -> getUserMedia succeeds -> audio frames flow
// -> Deepgram Metadata/Results come back.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'https://meetplay-production.up.railway.app';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',   // auto-grant mic/camera permission
    '--use-fake-device-for-media-stream', // fake mic/camera hardware
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
const page = await ctx.newPage();

const events = [];
page.on('console', (msg) => events.push(`CONSOLE: ${msg.type()} ${msg.text().slice(0, 140)}`));
page.on('pageerror', (err) => events.push(`PAGEERROR: ${String(err).slice(0, 200)}`));
page.on('request', (req) => {
  if (req.url().includes('/api/')) events.push(`REQ: ${req.method()} ${req.url()}`);
});
let audioBytes = 0;
let metadataAt = null;
let resultsAt = null;
page.on('websocket', (ws) => {
  events.push(`WS OPEN: ${ws.url()}`);
  ws.on('framesent', (e) => {
    const p = e.payload;
    if (typeof p === 'string') events.push(`WS-> ${p.slice(0, 60)}`);
    else audioBytes += p?.byteLength ?? 0;
  });
  ws.on('framereceived', (e) => {
    const p = String(e.payload).slice(0, 90);
    events.push(`WS<- ${p}`);
    if (p.includes('Metadata') && !metadataAt) metadataAt = Date.now();
    if (p.includes('Results')) resultsAt = Date.now();
  });
  ws.on('close', () => events.push(`WS CLOSE`));
});

const t0 = Date.now();
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);

await page.locator('input[placeholder="e.g. Monday Standup"]').fill('Railway FakeMic Test');
const createBtns = page.locator('button', { hasText: /^Create Room$/ });
await createBtns.last().click();
console.log('clicked submit Create Room');

// wait for room to mount (watch body text for the meeting UI)
let roomMounted = false;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1000);
  const bt = await page.locator('body').innerText();
  if (!bt.includes('Creating…') && (bt.includes('Leave') || bt.includes('captions') || bt.includes('Transcript') || bt.includes('Meeting'))) {
    roomMounted = true;
    console.log(`✅ room mounted after ${Date.now() - t0}ms`);
    break;
  }
}
if (!roomMounted) console.log('⚠️ room may not have fully mounted (body:', (await page.locator('body').innerText()).slice(0, 200), ')');

// wait up to 40s for Deepgram session (cold start can take ~13s)
console.log('\nwaiting up to 40s for STT session + audio...');
let lastAudio = 0;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  if (audioBytes > lastAudio) { lastAudio = audioBytes; if (i % 5 === 0) console.log(`  t=${Date.now() - t0}ms audio=${audioBytes}B`); }
  if (metadataAt && resultsAt) break;
}

console.log(`\n=== SUMMARY (${Date.now() - t0}ms total) ===`);
console.log(`room mounted: ${roomMounted}`);
console.log(`WS opened: ${events.some((e) => e.includes('/api/stt'))}`);
console.log(`audio frames sent to server: ${audioBytes} bytes`);
console.log(`Metadata at: ${metadataAt ? metadataAt - t0 + 'ms' : 'NEVER'}`);
console.log(`Results at: ${resultsAt ? resultsAt - t0 + 'ms' : 'NEVER'}`);

console.log('\n=== KEY EVENTS ===');
for (const e of events.filter((x) => x.includes('/api/') || x.includes('Deepgram') || x.includes('Metadata') || x.includes('Results') || x.includes('getUserMedia') || x.includes('Configure'))) {
  console.log('  ' + e);
}

await browser.close();
const ok = events.some((e) => e.includes('/api/stt')) && metadataAt && audioBytes > 0;
process.exit(ok ? 0 : 1);
