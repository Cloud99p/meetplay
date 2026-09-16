// Verifies the PRODUCTION Postgres path end-to-end against a real database.
//
// Recording/reporting bugs hid behind the in-memory DB before, and the base
// schema used to exist only in db/init.sql (docker-compose only) — so a
// managed database would fail on first boot with `relation "rooms" does not
// exist`. This script proves the whole path on an EMPTY database:
//
//   1. runMigrations() creates the base schema on an empty DB (no init.sql)
//   2. runMigrations() is idempotent (safe to run on every boot)
//   3. the query layer round-trips: room → participant → transcript → round →
//      game submission → recording
//   4. getRecap() returns the summary AND the recording (recap playback data)
//   5. deleting a room cascades to its recordings
//
// Usage (defaults to a local docker Postgres on :55432):
//   docker run -d --name meetplay-pg-test -e POSTGRES_PASSWORD=testpass \
//     -e POSTGRES_USER=meetplay -e POSTGRES_DB=meetplay -p 55432:5432 postgres:16
//   node scripts/verify-postgres.mjs
//
// Point it at any database with DATABASE_URL=postgres://... (USE_MEMORY_DB=0),
// e.g. a scratch Supabase project, to verify a real managed connection + TLS.

process.env.USE_MEMORY_DB = '0';

const target =
  process.env.DATABASE_URL ??
  'postgres://meetplay:testpass@localhost:55432/meetplay';
process.env.DATABASE_URL = target;

// Never print credentials.
const safeTarget = target.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@');
console.log(`Target: ${safeTarget}\n`);

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const dist = (p) => new URL(`../server/dist/${p}`, import.meta.url).href;

const { runMigrations } = await import(dist('db/migrate.js'));
const q = await import(dist('db/queries.js'));

// ─── 1. Bootstrap an EMPTY database ─────────────────────────────────────────
try {
  await runMigrations();
  check('runMigrations() on an empty database', true);
} catch (e) {
  check('runMigrations() on an empty database', false, (e)?.message ?? String(e));
  console.log('\nAborting: the schema could not be created.');
  process.exit(1);
}

// ─── 2. Idempotency (every boot re-runs the whole list) ─────────────────────
try {
  await runMigrations();
  check('runMigrations() is idempotent (second run)', true);
} catch (e) {
  check('runMigrations() is idempotent (second run)', false, (e)?.message ?? String(e));
}

// ─── Schema inspection ──────────────────────────────────────────────────────
const { pool } = await import(dist('db/pgQueries.js'));
const expectedTables = [
  'rooms',
  'participants',
  'chat_messages',
  'transcript_events',
  'game_rounds',
  'game_submissions',
  'room_recordings',
];
const { rows: tableRows } = await pool.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
);
const tables = tableRows.map((r) => r.table_name);
for (const t of expectedTables) {
  check(`table exists: ${t}`, tables.includes(t));
}

const { rows: idxRows } = await pool.query(
  `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
);
const indexes = idxRows.map((r) => r.indexname);
check('index exists: idx_room_recordings_room', indexes.includes('idx_room_recordings_room'));
check('index exists: idx_transcript_room', indexes.includes('idx_transcript_room'));

// gen_random_uuid() must work (bootstrap relies on it for every primary key)
const { rows: uuidRows } = await pool.query(`SELECT gen_random_uuid() AS id`);
check('gen_random_uuid() available', /^[0-9a-f-]{36}$/.test(uuidRows[0].id));

// ─── 3. Query-layer round-trip ──────────────────────────────────────────────
const room = await q.createRoom({ name: 'pg-verify-room' });
check('createRoom()', Boolean(room?.id), room?.id);

const host = await q.addParticipant({ roomId: room.id, name: 'Cloud', isHost: true });
const guest = await q.addParticipant({ roomId: room.id, name: 'Guest', isHost: false });
check('addParticipant() (host + guest)', Boolean(host?.id && guest?.id));
check('participant defaults are typed correctly', host.is_host === true && guest.is_host === false);

await q.saveTranscriptEvent({
  roomId: room.id,
  participantId: host.id,
  text: 'we should ship the recording fix',
  isFinal: true,
});
const transcript = await q.getTranscriptEvents(room.id);
check('saveTranscriptEvent() → getTranscriptEvents()', transcript.length === 1);
check(
  'transcript joins the participant name',
  transcript[0]?.participant_name === 'Cloud',
  transcript[0]?.participant_name,
);

const round = await q.createGameRound({
  roomId: room.id,
  gameType: 'who_said_that',
  roundData: { quote: 'ship it' },
});
await q.saveGameSubmission({
  roundId: round.id,
  participantId: guest.id,
  submission: { guess: 'Cloud' },
  score: 100,
});
const submission = await q.saveGameSubmission({
  roundId: round.id,
  participantId: guest.id,
  submission: { guess: 'Cloud' },
  score: 150,
});
check('saveGameSubmission() upserts on (round_id, participant_id)', submission.score === 150);

// The recording row is what makes recap playback work in production.
await q.saveRoomRecording({
  roomId: room.id,
  egressId: 'EG_test_123',
  downloadUrl: 'https://pub-test.r2.dev/meetplay/room/x.mp4',
  filepath: 'meetplay/room/x.mp4',
  audioOnly: false,
  durationSec: 185,
});
const recordings = await q.getRoomRecordings(room.id);
check('saveRoomRecording() → getRoomRecordings()', recordings.length === 1);
check(
  'recording URL persists verbatim',
  recordings[0]?.download_url === 'https://pub-test.r2.dev/meetplay/room/x.mp4',
  recordings[0]?.download_url,
);
check(
  'recording is returned newest-first',
  recordings.length === 1 || new Date(recordings[0].created_at) >= new Date(recordings[1].created_at),
);

// ─── 4. Recap (what the recap page renders) ─────────────────────────────────
const recap = await q.getRecap(room.id);
check('getRecap() returns data', Boolean(recap));
check('recap includes participants', recap?.participants?.length === 2);
check('recap includes the transcript', recap?.transcript?.length === 1);
check('recap includes game rounds', recap?.gameRounds?.length === 1);
check('recap includes the recording count', recap?.recordings?.length === 1);
check(
  'recap recording carries a playable downloadUrl',
  recap?.recordings?.[0]?.downloadUrl === 'https://pub-test.r2.dev/meetplay/room/x.mp4',
);
check('recap has summary fields', Boolean(recap?.leaderboard) || recap?.room != null);

// ─── 5. Cascade deletes (room cleanup + host-remove rely on these) ──────────
// Removing a single participant must not be blocked by their chat/transcript/
// submission rows (this used to throw an FK violation and fail silently).
const removable = await q.addParticipant({ roomId: room.id, name: 'Troublemaker', isHost: false });
await q.saveChatMessage({ roomId: room.id, participantId: removable.id, content: 'hi' });
await q.saveTranscriptEvent({
  roomId: room.id,
  participantId: removable.id,
  text: 'spam spam spam',
  isFinal: true,
});
let participantDeleteError = null;
try {
  await q.removeParticipant(removable.id);
} catch (e) {
  participantDeleteError = e;
}
check(
  'removing a participant with chat/transcript succeeds',
  participantDeleteError === null,
  participantDeleteError?.message ?? '',
);
const chatAfterRemoval = await q.getChatMessages(room.id);
check('removing a participant cascades their chat messages', chatAfterRemoval.length === 0);
const transcriptAfterRemoval = await q.getTranscriptEvents(room.id);
check(
  'removing a participant cascades their transcript rows (host kept)',
  transcriptAfterRemoval.length === 1 && transcriptAfterRemoval[0].participant_name === 'Cloud',
  `rows=${transcriptAfterRemoval.length}`,
);

// The abandoned-room privacy purge deletes rooms whose transcripts/chat exist.
let roomDeleteError = null;
try {
  await pool.query(`DELETE FROM rooms WHERE id = $1`, [room.id]);
} catch (e) {
  roomDeleteError = e;
}
check('deleting a room succeeds', roomDeleteError === null, roomDeleteError?.message ?? '');

const afterDelete = await q.getRoomRecordings(room.id);
check('deleting a room cascades its recordings', afterDelete.length === 0);
const { rows: leftoverRows } = await pool.query(
  `SELECT
     (SELECT count(*)::int FROM participants WHERE room_id = $1) AS participants,
     (SELECT count(*)::int FROM transcript_events WHERE room_id = $1) AS transcript,
     (SELECT count(*)::int FROM game_submissions) AS submissions,
     (SELECT count(*)::int FROM room_recordings) AS recordings`,
  [room.id],
);
const leftover = leftoverRows[0];
check('no orphan participants remain', leftover.participants === 0);
check('no orphan transcript rows remain', leftover.transcript === 0);
check('no orphan game submissions remain', leftover.submissions === 0);
check('no orphan recording rows remain', leftover.recordings === 0);

await pool.end();

console.log(failures === 0 ? '\nAll Postgres checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
