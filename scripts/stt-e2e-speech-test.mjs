// END-TO-END speech test: synthesize real speech with Deepgram TTS,
// stream the PCM through MeetPlay's /api/stt via the Vite proxy (the exact
// browser path), and verify words come back as Results.
import WebSocket from "ws";
import fs from "fs";

const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const key = (env.match(/^DEEPGRAM_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!key) { console.error("no DEEPGRAM_API_KEY in .env"); process.exit(1); }

const text = "Hello from MeetPlay, this is a caption test.";
console.log("1. Synthesizing speech via Deepgram TTS...");
const ttsRes = await fetch("https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&container=none&encoding=linear16&sample_rate=16000", {
  method: "POST",
  headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ text }),
});
if (!ttsRes.ok) { console.error("TTS failed:", ttsRes.status, await ttsRes.text()); process.exit(1); }
const pcm = Buffer.from(await ttsRes.arrayBuffer());
console.log(`   got ${pcm.length} bytes PCM16 16kHz`);

console.log("2. Streaming through ws://localhost:5173/api/stt (Vite proxy path)...");
const ws = new WebSocket("ws://localhost:5173/api/stt", { headers: { Origin: "http://localhost:5173" } });
const t0 = Date.now();
let words = null;

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "Configure", encoding: "linear16", sample_rate: 16000, channels: 1,
    model: "nova-2", interim_results: true, punctuate: true,
  }));
  // stream in chunks like the browser mic would
  const chunk = 16000 * 2 * 0.1; // 100ms
  for (let i = 0; i < pcm.length; i += chunk) {
    ws.send(pcm.subarray(i, i + chunk));
  }
  // small silence then close to force final transcript
  setTimeout(() => ws.close(), 1500);
});

ws.on("message", (data) => {
  let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
  if ((msg.type === "Result" || msg.type === "Results") && msg.channel?.alternatives?.[0]?.transcript) {
    const t = msg.channel.alternatives[0].transcript;
    if (t.trim()) { words = t; console.log(`+${Date.now() - t0}ms Result: "${t}"`); }
  }
  if (msg.type === "Error") console.log("server error:", JSON.stringify(msg).slice(0, 200));
});

ws.on("close", () => {
  if (words) {
    console.log(`\n\u2705 WORDS PICKED UP (${Date.now() - t0}ms): "${words}"`);
    process.exit(0);
  } else {
    console.log("\n\u274c NO WORDS RETURNED");
    process.exit(2);
  }
});
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(3); });
setTimeout(() => { console.log("TIMEOUT 25s"); ws.close(); process.exit(1); }, 25000);
