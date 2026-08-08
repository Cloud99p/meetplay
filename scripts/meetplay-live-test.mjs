// MeetPlay integration test against LIVE omnilearn API
// Key is passed via env var MEETPLAY_KEY (read by the runner from meetplay/.env)
import { readFileSync } from "node:fs";

const BASE = "https://omnilearn-api-production.up.railway.app";
const KEY = process.env.MEETPLAY_KEY;
if (!KEY) { console.error("MEETPLAY_KEY env not set"); process.exit(1); }

const H = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: H });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const roomId = `meetplay-demo-${Date.now()}`;
const results = [];

// 1. Captions -> record (exactly like MeetPlay's record with service metadata)
const captions = [
  { content: "Hey everyone, welcome to the design review", speakerId: "alice" },
  { content: "I think the new onboarding flow is much cleaner now", speakerId: "bob" },
  { content: "Can we move the pricing section higher?", speakerId: "alice" },
];
for (let i = 0; i < captions.length; i++) {
  const c = captions[i];
  const r = await post("/api/v1/knowledge/record", {
    type: "utterance",
    data: { content: c.content, speakerId: c.speakerId, roomId, seq: i },
    metadata: { meetingId: roomId, source: "meetplay", serviceName: "meetplay" },
  });
  results.push([`record caption ${i + 1} (${c.speakerId})`, r.status, r.json.success === true ? "ok" : JSON.stringify(r.json).slice(0, 60)]);
}

// 2. Who-Said-That style search: query content, filter by room
const r2 = await post("/api/v1/knowledge/search", {
  query: "onboarding flow cleaner",
  limit: 10,
  metadataFilter: { meetingId: roomId },
});
const found = r2.json.results || [];
const speakers = [...new Set(found.map((n) => n.data?.speakerId))];
results.push(["search (who-said-that)", r2.status, `found=${found.length} speakers=${speakers.join(",")}`]);

// 3. Search by exact phrase for quote verification
const r3 = await post("/api/v1/knowledge/search", {
  query: "pricing section higher",
  limit: 5,
  metadataFilter: { meetingId: roomId },
});
const quoteHit = (r3.json.results || []).some((n) => String(n.data?.content || "").includes("pricing"));
results.push(["quote lookup", r3.status, quoteHit ? "found pricing quote ✅" : "miss"]);

// 4. Stats (recap data source)
const r4 = await get("/api/v1/services/me/stats");
const s = r4.json?.stats || {};
results.push(["service stats", r4.status, `totalNodes=${s.totalNodes} nodesByType=${JSON.stringify(s.nodesByType || []).slice(0, 60)}`]);

// 5. Cleanup — delete room nodes
const r5 = await post("/api/v1/knowledge/delete", { metadataFilter: { meetingId: roomId } });
results.push(["cleanup delete", r5.status, r5.json.success === true ? `deleted=${r5.json.deleted}` : "fail"]);

console.log("\n=== MEETPLAY INTEGRATION (LIVE) ===");
let pass = 0;
for (const [name, status, detail] of results) {
  const ok = status === 200 || status === 201;
  if (ok) pass++;
  console.log(`${ok ? "✅" : "❌"} [${status}] ${name} — ${detail}`);
}
console.log(`\n${pass}/${results.length} passed`);
