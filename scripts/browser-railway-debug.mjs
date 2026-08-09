// Debug: drive the LIVE Railway app and dump EVERYTHING (all events) to see
// where the room-create flow stops before STT starts.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'https://meetplay-production.up.railway.app';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const events = [];
page.on('console', (msg) => events.push(`CONSOLE: ${msg.type()} ${msg.text().slice(0, 160)}`));
page.on('pageerror', (err) => events.push(`PAGEERROR: ${String(err).slice(0, 200)}`));
page.on('request', (req) => {
  if (req.url().includes('/api/') || req.url().includes('livekit')) events.push(`REQ: ${req.method()} ${req.url()}`);
});
page.on('websocket', (ws) => {
  events.push(`WS OPEN: ${ws.url()}`);
  ws.on('framesent', (e) => events.push(`WS-> ${String(e.payload).slice(0, 60)}`));
  ws.on('framereceived', (e) => events.push(`WS<- ${String(e.payload).slice(0, 100)}`));
  ws.on('close', () => events.push(`WS CLOSE`));
});

console.log('1. Loading page...');
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);

// Dump the landing UI state
const text = await page.locator('body').innerText();
console.log('=== BODY TEXT (first 800) ===');
console.log(text.slice(0, 800));

console.log('\n2. Clicking FIRST "Create Room"...');
const createBtn = page.locator('button', { hasText: /^Create Room$/ }).first();
console.log('   count:', await createBtn.count());
await createBtn.click();
await page.waitForTimeout(2500);

const text2 = await page.locator('body').innerText();
console.log('=== BODY TEXT after click (first 600) ===');
console.log(text2.slice(0, 600));

console.log('\n3. Filling inputs...');
const inputs = page.locator('input');
const n = await inputs.count();
console.log('   input count:', n);
for (let i = 0; i < Math.min(n, 6); i++) {
  const ph = await inputs.nth(i).getAttribute('placeholder');
  console.log(`   input[${i}] placeholder="${ph}"`);
}
if (n > 0) {
  await inputs.first().fill('Railway Browser Test');
  await page.waitForTimeout(800);
}
// maybe a submit button appeared
const allBtns = await page.locator('button').allTextContents();
console.log('   buttons now:', allBtns);

console.log('\n4. Waiting 8s for STT...');
await page.waitForTimeout(8000);

console.log('\n=== ALL EVENTS ===');
for (const e of events.slice(0, 60)) console.log('  ' + e);

await browser.close();
