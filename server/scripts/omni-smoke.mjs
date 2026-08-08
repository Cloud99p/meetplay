// omni-smoke.mjs — round-trip smoke test for the Omnilearn V1 knowledge API.
// Mirrors omniClient.ts payloads exactly: batch → search(metadataFilter) →
// delete(metadataFilter) → search(empty). Run: node scripts/omni-smoke.mjs
const BASE = process.env.OMNILEARN_URL ?? 'http://localhost:8080';
const meetingId = `meetplay-smoke-${Date.now().toString(36)}`;

async function call(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const results = [];
function log(step, { status, json }) {
  const ok = status >= 200 && status < 300;
  results.push({ step, status, ok });
  console.log(`${ok ? '✅' : '❌'} ${step} [${status}]`, JSON.stringify(json).slice(0, 220));
}

// 1. Batch record 3 utterances (same shape as omniClient RoomBatcher.flush)
log('batch', await call('/api/v1/knowledge/batch', {
  records: [
    { type: 'utterance', data: { text: 'The quarterly roadmap review is scheduled for next Tuesday at ten', speakerId: 'p-smoke-1', speakerName: 'Amina' } },
    { type: 'utterance', data: { text: 'We should prioritize the mobile app redesign before the holiday release', speakerId: 'p-smoke-2', speakerName: 'Chidi' } },
    { type: 'utterance', data: { text: 'Customer feedback shows the onboarding flow is the biggest pain point', speakerId: 'p-smoke-3', speakerName: 'Bisi' } },
  ],
  metadata: { meetingId, ts: new Date().toISOString() },
}));

// 2. Search filtered by meetingId (same shape as omniClient.getQuotes)
const search = await call('/api/v1/knowledge/search', {
  metadataFilter: { meetingId },
  type: 'utterance',
  limit: 10,
});
log('search (metadataFilter)', search);

const quotes = (search.json?.results ?? [])
  .map((r) => ({ text: r?.data?.text, speakerId: r?.data?.speakerId, speakerName: r?.data?.speakerName }))
  .filter((q) => q.text && q.speakerId);
console.log(`   → ${quotes.length} quotes returned`);
quotes.forEach((q) => console.log(`   • ${q.speakerName}: "${q.text.slice(0, 60)}"`));

// 3. Delete by meetingId (privacy cleanup, same shape as omniClient.deleteMeeting)
log('delete (metadataFilter)', await call('/api/v1/knowledge/delete', {
  metadataFilter: { meetingId },
}));

// 4. Search again — must be empty
const after = await call('/api/v1/knowledge/search', {
  metadataFilter: { meetingId },
  type: 'utterance',
  limit: 10,
});
log('search after delete', after);
const remaining = after.json?.results?.length ?? 0;
console.log(`   → ${remaining} nodes remain`);

const allOk = results.every((r) => r.ok) && quotes.length >= 2 && remaining === 0;
console.log(allOk ? '\nSMOKE TEST PASSED ✅' : '\nSMOKE TEST FAILED ❌');
// Use exitCode + natural drain instead of process.exit() (avoids Windows
// libuv "UV_HANDLE_CLOSING" assertion from pending fetch sockets).
process.exitCode = allOk ? 0 : 1;
