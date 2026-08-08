// Probe MeetPlay /api/stt with the EXACT payload the DeepgramAdapter sends
import WebSocket from "ws";

const url = "ws://localhost:3001/api/stt";
const ws = new WebSocket(url, { headers: { Origin: "http://localhost:5173" } });

const events = [];
const t0 = Date.now();

ws.on("open", () => {
  console.log("WS open (client->proxy)");
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
  events.push(msg);
  console.log(`+${Date.now() - t0}ms msg:`, JSON.stringify(msg).slice(0, 140));
  // Deepgram v1 emits Metadata/Open events on connect; any of these = upstream alive
  if (msg.type === "Metadata" || msg.type === "Open" || msg.type === "Result" || msg.type === "Error") {
    const ok = msg.type !== "Error";
    console.log(ok ? "\n✅ UPSTREAM ALIVE (deepgram session established)" : "\n❌ ERROR FROM SERVER");
    ws.close();
    process.exit(ok ? 0 : 2);
  }
});

ws.on("error", (e) => { console.log("WS error:", e.message); process.exit(3); });
setTimeout(() => {
  console.log("TIMEOUT 15s — events:", events.length ? events.map(e => e.type).join(",") : "none");
  ws.close();
  process.exit(1);
}, 15000);
