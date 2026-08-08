// Full WS test: join room, toggle off + on via API, verify broadcast state
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const BASE = "http://localhost:3001";
const WS_BASE = "ws://localhost:3001";

async function req(method, path, body, token) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json; try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
}

// 1. create room + host
const created = await req("POST", "/api/rooms", { name: `ws-toggle-${Date.now()}` });
const roomId = created.json?.room?.id;
const hostToken = created.json?.token;
const hostId = created.json?.participant?.id;
console.log("room:", roomId, "host:", hostId);

// 2. host connects WS
const ws = new WebSocket(`${WS_BASE}/ws?roomId=${encodeURIComponent(roomId)}&participantId=${encodeURIComponent(hostId)}&token=${encodeURIComponent(hostToken)}`);
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
console.log("WS connected");

// collect transcript:toggled messages
const toggles = [];
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "transcript:toggled") toggles.push(m.payload.enabled);
});

// wait for room:state
await new Promise((r) => setTimeout(r, 500));

// 3. toggle OFF
const off = await req("POST", `/api/rooms/${roomId}/transcript/toggle`, { enabled: false }, hostToken);
console.log("toggle OFF:", off.status, JSON.stringify(off.json));
await new Promise((r) => setTimeout(r, 500));

// 4. toggle ON
const on = await req("POST", `/api/rooms/${roomId}/transcript/toggle`, { enabled: true }, hostToken);
console.log("toggle ON:", on.status, JSON.stringify(on.json));
await new Promise((r) => setTimeout(r, 500));

console.log("\nWS broadcasts received (transcript:toggled):", JSON.stringify(toggles));
ws.close();
