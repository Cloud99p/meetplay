// omni-smoke-sdk.ts — round-trip smoke test for the VENDORED OmniLearn SDK,
// exactly as omniClient.ts uses it: recordBatch → search(metadataFilter) →
// delete(metadataFilter) → search(empty). Run: npx tsx scripts/omni-smoke-sdk.ts
import { OmniLearnClient } from '../src/intelligence/omnilearn-sdk/index.js';

const BASE = process.env.OMNILEARN_URL ?? 'http://localhost:8080';
const meetingId = `meetplay-sdk-smoke-${Date.now().toString(36)}`;

const client = new OmniLearnClient({
  apiKey: 'meetplay-local',
  apiBaseUrl: BASE,
  serviceName: 'meetplay',
  serviceVersion: '0.1.0',
  domain: 'meetings',
  enableLogging: false,
  retryAttempts: 1,
  timeout: 6000,
});

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
function log(step: string, ok: boolean, detail: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${step} — ${detail}`);
}

try {
  // 1. recordBatch (same shape as omniClient RoomBatcher.flush)
  const batch = await client.recordBatch({
    metadata: { meetingId, ts: new Date().toISOString() },
    records: [
      { type: 'utterance', data: { text: 'The quarterly roadmap review is scheduled for next Tuesday at ten', speakerId: 'p-smoke-1', speakerName: 'Amina' } },
      { type: 'utterance', data: { text: 'We should prioritize the mobile app redesign before the holiday release', speakerId: 'p-smoke-2', speakerName: 'Chidi' } },
      { type: 'utterance', data: { text: 'Customer feedback shows the onboarding flow is the biggest pain point', speakerId: 'p-smoke-3', speakerName: 'Bisi' } },
    ],
  });
  log('recordBatch', batch.recorded === 3, JSON.stringify(batch));

  // 2. search filtered by meetingId (same shape as omniClient.getQuotes)
  const search = await client.search({ metadataFilter: { meetingId }, types: ['utterance'], limit: 10 });
  log('search(metadataFilter)', search.nodes.length === 3, `nodes=${search.nodes.length}`);
  const first = search.nodes[0]?.data;
  log('quote shape', !!first?.text && !!first?.speakerId, JSON.stringify(first).slice(0, 140));

  // 3. delete by meetingId (same shape as omniClient.deleteMeeting)
  const del = await client.delete({ metadataFilter: { meetingId } });
  log('delete(metadataFilter)', del.deleted >= 3, JSON.stringify(del));

  // 4. verify empty
  const after = await client.search({ metadataFilter: { meetingId }, types: ['utterance'], limit: 10 });
  log('search after delete', after.nodes.length === 0, `nodes=${after.nodes.length}`);
} catch (e) {
  log('exception', false, String((e as Error).message ?? e));
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? '\n🎉 SDK SMOKE PASSED' : `\n${failed.length} FAILURES`);
process.exit(failed.length === 0 ? 0 : 1);
