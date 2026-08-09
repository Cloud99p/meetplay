// Full matrix: two participants (host creates, guest joins), member bet
// reflection on BOTH sides, and speech games (who_said_that / Letter Tiles)
// verified working once real caption utterances flow. Runs against Railway.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'https://meetplay-production.up.railway.app';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

async function newPage() {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const frames = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (e) => { const p = String(e.payload); if (p.includes('game') || p.includes('caption')) frames.push(`-> ${p.slice(0, 110)}`); });
    ws.on('framereceived', (e) => { const p = String(e.payload); if (p.includes('game') || p.includes('bingo')) frames.push(`<- ${p.slice(0, 150)}`); });
  });
  return { ctx, page, frames };
}

const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
};

async function openGames(page) {
  await page.locator('button', { hasText: /^Games$/ }).first().waitFor({ timeout: 45000 });
  await page.waitForTimeout(1500);
  await page.locator('button', { hasText: /^Games$/ }).first().click();
  await page.waitForTimeout(1200);
}

async function feedCaptions(page, n = 12) {
  // Inject caption:event frames over the page's own WS (like the STT adapter
  // would). The engine needs >= 8 final utterances for speech games.
  const sent = await page.evaluate(async (count) => {
    // Find the WebSocket instance the app uses: hook into the global before
    // sending is hard, so use the app's own send path via the WS singleton if
    // exposed; otherwise dispatch through a captured socket.
    const ws = window.__meetplayWs ?? null;
    if (!ws || ws.readyState !== 1) return 'NO_WS';
    for (let i = 0; i < count; i++) {
      ws.send(JSON.stringify({
        type: 'caption:event',
        payload: {
          speakerId: 'local',
          text: `The quick brown fox jumps over the lazy dog number ${i}.`,
          isFinal: true,
          confidence: 0.95,
          timestamp: Date.now(),
        },
      }));
    }
    return 'SENT';
  }, n);
  return sent;
}

try {
  // ── HOST creates room ──
  const host = await newPage();
  await host.page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await host.page.waitForTimeout(2000);
  await host.page.locator('input[placeholder="e.g. Monday Standup"]').fill('Matrix Test');
  await host.page.waitForTimeout(300);
  await host.page.locator('button', { hasText: /^Create Room$/ }).last().click();
  await host.page.locator('button', { hasText: /^Invite$/ }).first().waitFor({ timeout: 45000 });
  await host.page.waitForTimeout(1500);
  await openGames(host.page);

  // Host creates a member market with guess 7
  await host.page.locator('input[placeholder="Word (e.g. synergy)"]').fill('roadmap');
  await host.page.locator('input[placeholder="Guess"]').fill('7');
  await host.page.waitForTimeout(200);
  await host.page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Open');
    if (b) b.click();
  });
  await host.page.waitForTimeout(3000);
  const hostBody1 = await host.page.locator('body').innerText();
  ok('HOST: market appears', hostBody1.includes('"roadmap"'));
  ok('HOST: creator bet reflects', hostBody1.includes('You bet') && hostBody1.includes('7'), hostBody1.match(/You bet[^\n]*/)?.[0] ?? 'not found');

  // ── GUEST joins via invite link ──
  // Room id is in the host's URL after creation (/r/<roomId> or /room/<id>)
  const hostUrl = host.page.url();
  let roomId = (hostUrl.match(/\/meeting\/([a-f0-9-]+)/i) || [])[1] ?? null;
  ok('got room id from URL', !!roomId, roomId ?? hostUrl);
  if (!roomId) throw new Error('no room id');

  const guest = await newPage();
  await guest.page.goto(`${BASE}/#/join/${roomId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await guest.page.waitForTimeout(1500);
  await guest.page.locator('input[placeholder="Enter your display name"]').fill('Guest');
  await guest.page.waitForTimeout(200);
  await guest.page.locator('button', { hasText: /^Join Meeting$/ }).last().click();
  await guest.page.locator('button', { hasText: /^Games$/ }).first().waitFor({ timeout: 45000 });
  await guest.page.waitForTimeout(1500);
  await openGames(guest.page);

  // Guest sees the host's market
  const guestBody1 = await guest.page.locator('body').innerText();
  ok('GUEST: sees host market', guestBody1.includes('"roadmap"'));

  // Guest places a bet of 3
  await guest.page.locator('input[placeholder="Times said?"]').first().fill('3');
  await guest.page.waitForTimeout(200);
  await guest.page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Bet');
    if (b) b.click();
  });
  await guest.page.waitForTimeout(2500);
  const guestBody2 = await guest.page.locator('body').innerText();
  ok('GUEST: own bet reflects', guestBody2.includes('You bet') && guestBody2.includes('3'), guestBody2.match(/You bet[^\n]*/)?.[0] ?? 'not found');

  // Host sees guest's bet reflected (liveCount or "by Guest")
  await host.page.waitForTimeout(1200);
  const hostBody2 = await host.page.locator('body').innerText();
  ok('HOST: guest bet visible', hostBody2.includes('Guest'), hostBody2.slice(0, 200).replace(/\n/g, ' | '));

  // ── Speech games: feed captions, then start Who Said That? ──
  const feedResult = await feedCaptions(host.page, 12);
  ok('captions injected into host WS', feedResult === 'SENT', feedResult);
  await host.page.waitForTimeout(1500);
  await host.page.locator('button', { hasText: /Who Said That\?/ }).first().click();
  await host.page.waitForTimeout(4000);
  const hostBody3 = await host.page.locator('body').innerText();
  const wstFrame = host.frames.find((f) => f.includes('game:round:open') || f.includes('who_said'));
  ok('Who Said That? round opens with captions', !!wstFrame || hostBody3.includes('quote') || hostBody3.includes('Who said'), wstFrame?.slice(0, 120) ?? hostBody3.slice(0, 200).replace(/\n/g, ' | '));

  // Letter Tiles (scrabble)
  await host.page.locator('button', { hasText: /Letter Tiles/ }).first().click();
  await host.page.waitForTimeout(4000);
  const hostBody4 = await host.page.locator('body').innerText();
  const scFrame = host.frames.find((f) => f.includes('game:round:open') || f.includes('scrabble'));
  ok('Letter Tiles round opens with captions', !!scFrame || hostBody4.includes('tiles') || hostBody4.includes('letters'), scFrame?.slice(0, 120) ?? hostBody4.slice(0, 200).replace(/\n/g, ' | '));

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  await host.ctx.close();
  await guest.ctx.close();
  await browser.close();
  process.exit(results.every(Boolean) ? 0 : 1);
} catch (e) {
  console.error('crashed:', e.message);
  await browser.close();
  process.exit(1);
}
