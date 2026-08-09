// Verify the browser DeepgramAdapter actually connects to /api/stt now.
// Drives the host create flow, then watches for the WS connection + Metadata.
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const run = async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const sttWs = [];
  const consoleLogs = [];
  page.on('websocket', (ws) => {
    if (ws.url().includes('/api/stt')) {
      sttWs.push(ws.url());
      ws.on('framesent', (e) => { if (e.payload.startsWith('{"type":"Configure"')) consoleLogs.push('CLIENT->WS Configure sent'); });
      ws.on('framereceived', (e) => {
        try {
          const m = JSON.parse(e.payload);
          if (m.type === 'Metadata') consoleLogs.push('SERVER->WS Metadata (deepgram session up)');
          if (m.type === 'Results') consoleLogs.push('SERVER->WS Results: ' + (m.channel?.alternatives?.[0]?.transcript ?? '').slice(0, 40));
        } catch {}
      });
    }
  });
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('DeepgramAdapter') || t.includes('STT') || t.includes('getUserMedia') || t.includes('stt')) consoleLogs.push('CONSOLE: ' + t.slice(0, 100));
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  // Host create flow
  await page.getByRole('textbox').first().fill('stt-check');
  const createButtons = page.getByRole('button', { name: /create room/i });
  await createButtons.last().click();
  await page.waitForURL(/\/room\//, { timeout: 20000 }).catch(() => {});
  console.log('navigated to', page.url());
  await page.waitForTimeout(6000);

  console.log('\n=== /api/stt connections seen by browser:', sttWs.length, '===');
  sttWs.forEach((u) => console.log('  ', u));
  console.log('\n=== events ===');
  consoleLogs.forEach((l) => console.log(' ', l));

  // Also check the toggle state text
  const toggle = await page.getByRole('button', { name: /captions/i }).textContent().catch(() => '(no toggle visible)');
  console.log('\ntoggle text:', toggle);

  await browser.close();
};
run().catch((e) => { console.error('REPRO ERROR:', e.message); process.exit(1); });
