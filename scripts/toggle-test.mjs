// Test the transcript toggle route: off then back on
// 1. Create room
// 2. Get host token
// 3. Toggle off (should return {enabled:false})
// 4. Toggle on  (should return {enabled:true})
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3001";

async function req(method, path, body, token) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json; try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
}

// create room
const created = await req("POST", "/api/rooms", { name: `toggle-test-${Date.now()}` });
console.log("create room:", created.status, JSON.stringify(created.json).slice(0, 120));
const roomId = created.json?.room?.id ?? created.json?.id;
const token = created.json?.room?.hostToken ?? created.json?.token ?? created.json?.host_token;
console.log("roomId:", roomId, "token:", token ? token.slice(0, 20) + "..." : "MISSING");

if (!roomId || !token) { console.log("cannot proceed"); process.exit(1); }

// toggle OFF
const off = await req("POST", `/api/rooms/${roomId}/transcript/toggle`, { enabled: false }, token);
console.log("\ntoggle OFF:", off.status, JSON.stringify(off.json));

// toggle ON
const on = await req("POST", `/api/rooms/${roomId}/transcript/toggle`, { enabled: true }, token);
console.log("toggle ON:", on.status, JSON.stringify(on.json));
