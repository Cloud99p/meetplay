// Browser repro: transcription ON (default) -> toggle OFF -> toggle ON, verify UI + STT
// Drives the HOST create flow (createAndJoin awaits LiveKit before navigating,
// so MeetingRoom never mounts with liveKitRoom=null — unlike snapshot-resume).
import { chromium } from "playwright";

const BASE = "http://localhost:5173";

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 160)}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message.slice(0, 160)}`));

  await page.context().grantPermissions(["microphone", "camera"], { origin: BASE });
  const toggles = [];
  page.on("request", (r) => {
    if (r.url().includes("transcript/toggle")) {
      try { toggles.push([r.method(), JSON.parse(r.postData() ?? "{}")]); }
      catch { toggles.push([r.method(), r.postData()]); }
    }
  });
  page.on("response", (r) => {
    if (r.url().includes("transcript/toggle")) {
      console.log("toggle response:", r.status(), r.url().split("/api")[1]);
    }
  });

  const wsFrames = [];
  page.on("websocket", (ws) => {
    const url = ws.url();
    ws.on("framesent", (f) => wsFrames.push(["SENT", url, f.payload.slice(0, 150)]));
    ws.on("framereceived", (f) => wsFrames.push(["RECV", url, f.payload.slice(0, 150)]));
  });

  // Stable identity so the server treats this browser as the room host
  await page.addInitScript((uid) => {
    localStorage.setItem("meetplay_user_id", uid);
  }, `repro-host-${Date.now()}`);

  // 1. Lobby (default view = Create Room)
  await page.goto(`${BASE}/#/`);
  await page.waitForTimeout(1200);

  // The form submit button (last "Create Room") — the first is the tab switch
  const createBtn = page.locator("button", { hasText: /^Create Room$/ }).last();
  const createEnabled = await createBtn.isVisible().catch(() => false);
  if (!createEnabled) {
    console.log("Create Room button not found — page text:", (await page.evaluate(() => document.body.innerText)).slice(0, 200));
    await page.screenshot({ path: "scripts/_toggle-0-lobby.png" });
    await browser.close();
    return;
  }
  await createBtn.click();

  // 2. Wait for the host to land in the meeting room (LiveKit connect completes first)
  const toggle = page.locator("button", { hasText: /Captions & games|Enable captions/i }).first();
  try {
    await toggle.waitFor({ timeout: 45000 });
  } catch {
    console.log("NO TOGGLE after 45s — page text:", (await page.evaluate(() => document.body.innerText)).slice(0, 300));
    console.log("\n=== console logs ===");
    logs.slice(-20).forEach((l) => console.log(" ", l));
    await page.screenshot({ path: "scripts/_toggle-none.png" });
    await browser.close();
    return;
  }
  await page.waitForTimeout(2000);

  const text0 = (await toggle.innerText()).trim();
  console.log("initial:", JSON.stringify(text0));
  await page.screenshot({ path: "scripts/_toggle-1-on.png" });

  // 3. Click to turn OFF
  await toggle.click();
  await page.waitForTimeout(3000);
  const text1 = (await toggle.innerText()).trim();
  console.log("after 1st click (expect OFF):", JSON.stringify(text1));
  await page.screenshot({ path: "scripts/_toggle-2-off.png" });

  // 4. Click to turn ON
  await toggle.click();
  await page.waitForTimeout(3000);
  const text2 = (await toggle.innerText()).trim();
  console.log("after 2nd click (expect ON):", JSON.stringify(text2));
  await page.screenshot({ path: "scripts/_toggle-3-on-again.png" });

  console.log("\n=== toggle API requests ===");
  toggles.forEach((t) => console.log(" ", JSON.stringify(t)));
  console.log("=== WS frames (transcript/room:state only) ===");
  wsFrames
    .filter(([dir, url, p]) => p.includes("transcript") || p.includes("room:state") || p.includes("caption"))
    .forEach(([dir, url, p]) => console.log(" ", dir, url.split("?")[0], p));
  console.log("=== all WS frame types ===");
  const types = {};
  wsFrames.forEach(([dir, url, p]) => {
    let t = "?";
    try { t = JSON.parse(p).type ?? "?non-json"; } catch { t = p.slice(0, 20); }
    const key = `${dir} ${t}`;
    types[key] = (types[key] ?? 0) + 1;
  });
  Object.entries(types).forEach(([k, v]) => console.log(" ", k, "x", v));
  console.log("=== console logs (last 25) ===");
  logs.slice(-25).forEach((l) => console.log(" ", l));
  await browser.close();
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
