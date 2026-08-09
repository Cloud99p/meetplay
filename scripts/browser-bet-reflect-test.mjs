// Precise: create a member market WITH a guess, then verify the creator's own
// bet reflects ("You bet X @ ×Y" banner) — plus place a bet on a SECOND
// market and verify it reflects too. Runs in a real browser against Railway.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'https://meetplay-production.up.railway.app';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const frames = [];
page.on('websocket', (ws) => {
  ws.on('framesent', (e) => { const p = String(e.payload); if (p.includes('game')) frames.push(`-> ${p.slice(0, 120)}`); });
  ws.on('framereceived', (e) => { const p = String(e.payload); if (p.includes('game') || p.includes('bingo')) frames.push(`<- ${p.slice(0, 160)}`); });
});

const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
};

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.locator('input[placeholder="e.g. Monday Standup"]').fill('Bet Reflect Test');
  await page.waitForTimeout(300);
  await page.locator('button', { hasText: /^Create Room$/ }).last().click();
  await page.locator('button', { hasText: /^Games$/ }).first().waitFor({ timeout: 45000 });
  await page.waitForTimeout(2000);
  await page.locator('button', { hasText: /^Games$/ }).first().click();
  await page.waitForTimeout(1500);

  // ── 1) Create a member market with guess 7 ──
  frames.length = 0;
  const wordInput = page.locator('input[placeholder="Word (e.g. synergy)"]');
  ok('bet form present', (await wordInput.count()) > 0);
  await wordInput.fill('roadmap');
  await page.locator('input[placeholder="Guess"]').fill('7');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Open');
    if (b) b.click();
  });
  await page.waitForTimeout(4000);

  const body1 = await page.locator('body').innerText();
  ok('market appears in UI', body1.includes('"roadmap"'), body1.slice(0, 160).replace(/\n/g, ' | '));
  const openFrame = frames.find((f) => f.includes('userMarket:open'));
  ok('server sent userMarket:open', !!openFrame, openFrame?.slice(0, 140));
  const betFrame = frames.find((f) => f.includes('userMarket:bet'));
  ok('server sent userMarket:bet (creator auto-bet)', !!betFrame, betFrame?.slice(0, 160));
  const errFrame = frames.find((f) => f.includes('userMarket:error'));
  if (errFrame) console.log('  ⚠️ error frame:', errFrame);
  ok('creator "You bet" banner shows', body1.includes('You bet') && body1.includes('×'), body1.match(/You bet[^\n]*/)?.[0] ?? 'not found');

  // ── 2) Place a bet on the created market via the Bet input ──
  frames.length = 0;
  const betInput = page.locator('input[placeholder="Times said?"]').first();
  if (await betInput.count()) {
    await betInput.fill('3');
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Bet');
      if (b) b.click();
    });
    await page.waitForTimeout(2500);
    const body2 = await page.locator('body').innerText();
    ok('bet placed via UI reflects', body2.includes('You bet') && body2.includes('3'), body2.match(/You bet[^\n]*/)?.[0] ?? 'not found');
  } else {
    ok('bet input present for market', false, 'no "Times said?" input found');
  }

  // ── 3) Buzzword Bingo still renders (regression) ──
  frames.length = 0;
  const bingoBtn = page.locator('button', { hasText: /Buzzword Bingo/ }).first();
  if (await bingoBtn.count()) {
    await bingoBtn.click();
    await page.waitForTimeout(3500);
    const body3 = await page.locator('body').innerText();
    const cardCount = await page.locator('button[aria-label^="bingo-"], [class*="grid"] [class*="rounded"]').count();
    ok('bingo card renders', body3.includes('Buzzword Bingo') && !body3.includes('No bingo card'), `grid cells: ${cardCount}`);
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  console.log('frames:', JSON.stringify(frames, null, 0).slice(0, 800));
  await browser.close();
  process.exit(results.every(Boolean) ? 0 : 1);
} catch (e) {
  console.error('crashed:', e.message);
  console.log('frames:', JSON.stringify(frames).slice(0, 1000));
  await browser.close();
  process.exit(1);
}
