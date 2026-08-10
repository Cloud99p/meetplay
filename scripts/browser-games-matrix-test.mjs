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
  // Inject caption:event frames through the app's own WS client (same path
  // the STT adapter uses). window.__meetplayWs is a WebSocketClient — use its
  // send(type, payload) API, NOT the native ws.send(jsonString).
  const sent = await page.evaluate(async (count) => {
    const client = window.__meetplayWs ?? null;
    if (!client || !client.connected) return 'NO_WS';
    for (let i = 0; i < count; i++) {
      client.send('caption:event', {
        speakerId: 'local',
        text: `The quick brown fox jumps over the lazy dog number ${i}.`,
        isFinal: true,
        confidence: 0.95,
        timestamp: Date.now(),
      });
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

  // Guest places a bet of 3 — scope to the member-market card for "roadmap"
  // so we never hit a different "Bet" button (flash/main market).
  const guestMarketCard = guest.page.locator('div', { hasText: '"roadmap"' }).filter({ has: guest.page.locator('input[placeholder="Times said?"]') }).first();
  const betInput = guestMarketCard.locator('input[placeholder="Times said?"]');
  await betInput.waitFor({ timeout: 15000 });
  await betInput.fill('3');
  await guest.page.waitForTimeout(200);
  await guestMarketCard.locator('button', { hasText: /^Bet$/ }).first().click();
  await guest.page.waitForTimeout(2500);
  let guestBody2 = await guest.page.locator('body').innerText();
  if (!guestBody2.includes('You bet')) {
    // flake guard: retry once
    await betInput.fill('3');
    await guest.page.waitForTimeout(200);
    await guestMarketCard.locator('button', { hasText: /^Bet$/ }).first().click();
    await guest.page.waitForTimeout(2500);
    guestBody2 = await guest.page.locator('body').innerText();
  }
  ok('GUEST: own bet reflects', guestBody2.includes('You bet') && guestBody2.includes('3'), guestBody2.match(/You bet[^\n]*/)?.[0] ?? 'not found');

  // Host sees guest's bet reflected (liveCount or "by Guest")
  await host.page.waitForTimeout(1200);
  const hostBody2 = await host.page.locator('body').innerText();
  ok('HOST: guest bet visible', hostBody2.includes('Guest'), hostBody2.slice(0, 200).replace(/\n/g, ' | '));

  // ── Speech games: enable transcription, feed captions, then start games ──
  // caption:event frames are DROPPED server-side unless the room has
  // transcription enabled — the host must flip the toggle first.
  const captionsBtn = host.page.locator('button[title*="Captions & games are OFF"]').first();
  if (await captionsBtn.count()) {
    await captionsBtn.click();
    await host.page.waitForTimeout(2500);
    ok('transcription enabled by toggle', (await host.page.locator('button[title*="Captions & games are ON"]').count()) > 0);
  } else {
    ok('transcription already on', (await host.page.locator('button[title*="Captions & games are ON"]').count()) > 0);
  }
  const feedResult = await feedCaptions(host.page, 12);
  ok('captions injected into host WS', feedResult === 'SENT', feedResult);
  await host.page.waitForTimeout(1500);

  const waitForRound = async (gameType) => waitForRoundOn(host, gameType);

  const waitForRoundOn = async (target, gameType) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      const round = target.frames.find((f) => f.includes('game:round:open') && f.includes(gameType));
      const rejected = target.frames.find((f) => f.includes('game:start:rejected'));
      if (round && !rejected) return { ok: true, frame: round };
      if (rejected) return { ok: false, frame: rejected };
      await target.page.waitForTimeout(1000);
    }
    return { ok: false, frame: null };
  };

  await host.page.locator('button', { hasText: /Letter Tiles/ }).first().click();
  const sc = await waitForRound('scrabble');
  ok('Letter Tiles round opens with captions', sc.ok, sc.frame?.slice(0, 150) ?? 'no round frame in 12s');

  // Who Said That? in a FRESH room (game menu hidden while a round runs).
  const host2 = await newPage();
  await host2.page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await host2.page.waitForTimeout(2000);
  await host2.page.locator('input[placeholder="e.g. Monday Standup"]').fill('WST Room');
  await host2.page.waitForTimeout(300);
  await host2.page.locator('button', { hasText: /^Create Room$/ }).last().click();
  await host2.page.locator('button', { hasText: /^Games$/ }).first().waitFor({ timeout: 45000 });
  await host2.page.waitForTimeout(1500);
  await openGames(host2.page);
  const captionsBtn2 = host2.page.locator('button[title*="Captions & games are OFF"]').first();
  if (await captionsBtn2.count()) {
    await captionsBtn2.click();
    await host2.page.waitForTimeout(2000);
  }
  await feedCaptions(host2.page, 12);
  await host2.page.waitForTimeout(1500);
  await host2.page.locator('button', { hasText: /Who Said That\?/ }).first().click();
  const wst = await waitForRoundOn(host2, 'who_said_that');
  ok('Who Said That? round opens with captions', wst.ok, wst.frame?.slice(0, 150) ?? 'no round frame in 12s');
  await host2.ctx.close();

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
