/**
 * FULL E2E — real room join through MeetPlay's actual WS handler into the
 * live Omnilearn knowledge graph.
 *
 * Flow:
 *   1. POST /api/rooms          → create room (host auto-joins)
 *   2. POST /api/rooms/:id/join → second participant joins (real token)
 *   3. WS connect (host)        → real websocket with room token
 *   4. transcript toggle ON     → captions accepted
 *   5. WS caption:event x4      → final utterances (mimics real STT feed)
 *   6. wait BATCH_FLUSH_MS+     → omniClient batcher flushes to Omnilearn
 *   7. GET /api/rooms/:id/recap → graph section shows recorded quotes
 *   8. live Omnilearn search    → nodes really landed in the graph
 *   9. POST /api/rooms/:id/end  → meeting end; verify privacy purge
 *
 * Run: npx tsx scripts/e2e-full-room.ts
 * Needs: MeetPlay :3001 + Omnilearn :8080 running.
 */
import WebSocket from 'ws';

const MP = process.env.MEETPLAY_URL || 'http://localhost:3001';
const OMNI = process.env.OMNILEARN_URL || 'http://localhost:8080';
const WS_URL = MP.replace(/^http/, 'ws') + '/ws';
const FLUSH_WAIT_MS = 14_000; // > OMNILEARN_FLUSH_MS (10s default)

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};
const j = async <T = any>(url: string, opts: any = {}): Promise<T> => {
  const { headers, ...rest } = opts;
  const r = await fetch(`${MP}${url}`, {
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    ...rest,
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body } as T;
};

const CAPTIONS = [
  { speakerId: 'p-e2e-host', text: 'Our Q3 roadmap has three big bets: the SDK, the knowledge graph, and the mobile app.' },
  { speakerId: 'p-e2e-guest', text: 'The SDK being generic for any service is what makes it interesting.' },
  { speakerId: 'p-e2e-host', text: 'Exactly — one knowledge layer, many products consuming it.' },
  { speakerId: 'p-e2e-guest', text: 'We should ship the onboarding flow before the hackathon demo.' },
];

function wsSend(ws: WebSocket, type: string, payload: unknown) {
  ws.send(JSON.stringify({ type, payload }));
}

async function main() {
  // 1. Create room
  const created = await j<{ status: number; body: any }>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `E2E ${new Date().toISOString()}`, userId: 'e2e-host-user' }),
  });
  check('POST /api/rooms', created.status === 201 && !!created.body.room?.id, `room=${created.body.room?.id}`);
  const roomId: string = created.body.room?.id;
  const hostId: string = created.body.participant?.id;
  const hostToken: string = created.body.token;
  const hostAuth = { Authorization: `Bearer ${hostToken}` };

  // 2. Join as guest
  const joined = await j<{ status: number; body: any }>(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: JSON.stringify({ participantName: 'E2E Guest', userId: 'e2e-guest-user' }),
  });
  check('POST /api/rooms/:id/join', joined.status === 201 && !!joined.body.participant?.id, `guest=${joined.body.participant?.id}`);

  // 3. Real WS connect as host
  const ws = new WebSocket(`${WS_URL}?roomId=${roomId}&participantId=${hostId}&token=${encodeURIComponent(hostToken)}`);
  const wsReady = await new Promise<boolean>((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('error', (e) => resolve(false));
    setTimeout(() => resolve(false), 5000);
  });
  check('WS connect (real token)', wsReady);
  if (!wsReady) process.exit(1);

  // 4. Enable transcription (host only)
  const toggled = await j<{ status: number; body: any }>(`/api/rooms/${roomId}/transcript/toggle`, {
    method: 'POST',
    headers: hostAuth,
    body: JSON.stringify({ enabled: true }),
  });
  check('transcript toggle ON', toggled.status === 200 && toggled.body.enabled === true);

  // 5. Push caption events over the real socket (mimics STT final feed)
  await new Promise((r) => setTimeout(r, 500));
  for (const c of CAPTIONS) {
    wsSend(ws, 'caption:event', { speakerId: c.speakerId, text: c.text, isFinal: true });
  }
  check('caption:event x4 sent', true);

  // Wait for WS broadcast echo (proves handler processed them)
  const echo = await new Promise<number>((resolve) => {
    let got = 0;
    const t = setTimeout(() => resolve(got), 3000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'caption:event') {
        got++;
        if (got >= CAPTIONS.length) { clearTimeout(t); resolve(got); }
      }
    });
  });
  check('WS caption echo broadcast', echo === CAPTIONS.length, `got ${echo}`);

  // 6. Wait for batcher flush to Omnilearn
  console.log(`\n⏳ waiting ${FLUSH_WAIT_MS / 1000}s for omniClient flush...`);
  await new Promise((r) => setTimeout(r, FLUSH_WAIT_MS));

  // 7. Recap route — graph section should list the quotes
  const recap = await j<{ status: number; body: any }>(`/api/rooms/${roomId}/recap`);
  const graph = recap.body?.graph;
  check('recap graph available', graph?.available === true, JSON.stringify(graph).slice(0, 80));
  check('recap graph quotes >= 4', (graph?.quotes?.length ?? 0) >= CAPTIONS.length, `quotes=${graph?.quotes?.length}`);

  // 8. LIVE Omnilearn search — nodes really in the graph under this meetingId
  const omniRes = await fetch(`${OMNI}/api/v1/knowledge/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metadataFilter: { meetingId: roomId }, limit: 20 }),
  });
  const omni = await omniRes.json();
  const nodes = omni.results ?? [];
  check('Omnilearn search(meetingId)', omniRes.status === 200 && nodes.length >= CAPTIONS.length, `nodes=${nodes.length}`);
  const texts = nodes.map((n: any) => n.data?.text ?? '');
  const hit = CAPTIONS.every((c) => texts.some((t: string) => t === c.text));
  check('all 4 captions in graph', hit, texts.slice(0, 1).map((t: string) => t.slice(0, 60)).join(' | '));

  // 9. End meeting → flushRoom + deleteMeeting (privacy purge)
  const ended = await j<{ status: number; body: any }>(`/api/rooms/${roomId}/end`, {
    method: 'POST',
    headers: hostAuth,
    body: JSON.stringify({}), // Fastify: empty body + json content-type = 400
  });
  check('POST /api/rooms/:id/end', ended.status === 200, `ok=${ended.body?.ok}`);

  await new Promise((r) => setTimeout(r, 3000));
  const after = await fetch(`${OMNI}/api/v1/knowledge/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metadataFilter: { meetingId: roomId }, limit: 20 }),
  });
  const afterJson = await after.json();
  const remaining = (afterJson.results ?? []).length;
  check('privacy purge (graph empty after end)', remaining === 0, `remaining=${remaining}`);

  ws.close();
  console.log(failures === 0 ? '\n🎉 FULL E2E PASSED — real room → real graph → privacy purge' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E FATAL:', e);
  process.exit(1);
});
