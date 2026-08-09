// Drive the LIVE Railway app properly: switch to Create tab, fill name,
// click SUBMIT Create Room, then watch for /api/stt WS + Metadata.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'https://meetplay-production.up.railway.app';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const events = [];
page.on('console', (msg) => events.push(`CONSOLE: ${msg.type()} ${msg.text().slice(0, 160)}`));
page.on('pageerror', (err) => events.push(`PAGEERROR: ${String(err).slice(0, 200)}`));
page.on('request', (req) => {
  if (req.url().includes('/api/')) events.push(`REQ: ${req.method()} ${req.url()}`);
});
page.on('websocket', (ws) => {
  events.push(`WS OPEN: ${ws.url()}`);
  ws.on('framesent', (e) => events.push(`WS-> ${String(e.payload).slice(0, 60)}`));
  ws.on('framereceived', (e) => events.push(`WS<- ${String(e.payload).slice(0, 100)}`));
  ws.on('close', () => events.push(`WS CLOSE`));
});

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);

// Fill room name
const nameInput = page.locator('input[placeholder="e.g. Monday Standup"]');
await nameInput.fill('Railway Browser Test');
await page.waitForTimeout(500);

// Click the SUBMIT Create Room (last one)
const createBtns = page.locator('button', { hasText: /^Create Room$/ });
console.log('create buttons:', await createBtns.count());
await createBtns.last().click();
console.log('clicked submit Create Room');
await page.waitForTimeout(3000);

// Should now be in the meeting room. Dump body to confirm.
const bodyText = await page.locator('body').innerText();
console.log('=== BODY after create (first 500) ===');
console.log(bodyText.slice(0, 500));

// Wait for STT to kick in (transcription ON by default for new rooms)
console.log('\nWaiting 12s for STT...');
await page.waitForTimeout(12000);

console.log('\n=== STT / API EVENTS ===');
const sttEvents = events.filter((e) => e.includes('/api/') || e.includes('Deepgram') || e.includes('getUserMedia') || e.includes('Metadata') || e.includes('Configure'));
for (const e of sttEvents.slice(0, 30)) console.log('  ' + e);

const opened = events.some((e) => e.includes('/api/stt'));
const metadata = events.some((e) => e.includes('Metadata'));
console.log(`\n${opened ? '✅' : '❌'} Browser opened WS to Railway /api/stt: ${opened}`);
console.log(`${metadata ? '✅' : '❌'} Received Metadata (Deepgram session up): ${metadata}`);

await browser.close();
process.exit(opened && metadata ? 0 : 1);
