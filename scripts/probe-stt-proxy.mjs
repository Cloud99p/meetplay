// Probe MeetPlay /api/stt THROUGH THE VITE PROXY (the real browser path)
// Usage: node scripts/probe-stt-proxy.mjs
import WebSocket from "ws";

const url = "ws://localhost:5173/api/stt";
const ws = new WebSocket(url, { headers: { Origin: "http://localhost:5173" } });

const t0 = Date.now();

ws.on("open", () => {
  console.log("WS open through Vite proxy :5173 -> backend :3001 -> Deepgram");
  ws.send(JSON.stringify({
    type: "Configure",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    model: "nova-2",
    diarize: true,
    interim_results: true,
    punctuate: true,
  }));
});

ws.on("message", (data) => {
  let msg; try { msg = JSON.parse(data.toString()); } catch { msg = { raw: data.toString().slice(0, 80) }; }
  console.log(`+${Date.now() - t0}ms msg:`, JSON.stringify(msg).slice(0, 160));
  if (msg.type === "Metadata" || msg.type === "Open" || msg.type === "Result") {
    console.log("\n\u2705 FULL PATH OK: browser WS -> Vite proxy -> backend -> Deepgram");
    ws.close();
    process.exit(0);
  }
  if (msg.type === "Error") {
    console.log("\n\u274c ERROR:", JSON.stringify(msg));
    ws.close();
    process.exit(2);
  }
});

ws.on("error", (e) => { console.log("WS error:", e.message); process.exit(3); });
setTimeout(() => { console.log("TIMEOUT 15s"); ws.close(); process.exit(1); }, 15000);
