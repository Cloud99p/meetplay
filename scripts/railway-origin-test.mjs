// Test whether sending an Origin header (like a real browser does) breaks the
// Railway /api/stt WS handshake or the Deepgram session.
// Compares: no Origin vs browser Origin.
import WebSocket from "ws";

const URL = process.env.STT_URL || "wss://meetplay-production.up.railway.app/api/stt";

function attempt(label, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, { headers });
    const t0 = Date.now();
    let state = "connecting";
    const timer = setTimeout(() => {
      if (state === "waiting") { console.log(`  ${label}: TIMEOUT (no Metadata in 12s)`); ws.close(); resolve(false); }
    }, 12000);

    ws.on("open", () => {
      state = "open";
      console.log(`  ${label}: WS open (${Date.now() - t0}ms)`);
      ws.send(JSON.stringify({ type: "Configure", encoding: "linear16", sample_rate: 16000, channels: 1, model: "nova-2", interim_results: true, punctuate: true }));
    });
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "Metadata") {
        console.log(`  ${label}: ✅ Metadata received (${Date.now() - t0}ms) — session up`);
        clearTimeout(timer);
        ws.close();
        resolve(true);
      } else if (m.type === "Error") {
        console.log(`  ${label}: ❌ server Error: ${m.message}`);
        clearTimeout(timer);
        ws.close();
        resolve(false);
      } else {
        console.log(`  ${label}: <- ${m.type}`);
      }
    });
    ws.on("error", (e) => { state = "error"; console.log(`  ${label}: ❌ ws error: ${e.message}`); clearTimeout(timer); resolve(false); });
    ws.on("close", (code) => { if (state !== "done") console.log(`  ${label}: closed code=${code}`); });
  });
}

console.log("A. No Origin header (Node client):");
const a = await attempt("A", {});
console.log("B. Browser Origin header:");
const b = await attempt("B", { Origin: "https://meetplay-production.up.railway.app" });
console.log("C. Sec-WebSocket-Protocol (like some clients):");
const c = await attempt("C", { Origin: "https://meetplay-production.up.railway.app", "Sec-WebSocket-Protocol": "v0" });

console.log(`\nResult: A=${a ? "OK" : "FAIL"} B=${b ? "OK" : "FAIL"} C=${c ? "OK" : "FAIL"}`);
process.exit(a && b && c ? 0 : 1);
