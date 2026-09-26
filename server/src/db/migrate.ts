// Idempotent schema migrations, applied automatically at server startup.
//
// No manual psql / init.sql step is needed no matter where Postgres runs
// (Docker, Railway, Render, managed DB, ...). Every statement must be safe
// to run repeatedly — prefer `ADD COLUMN IF NOT EXISTS` / `CREATE ... IF NOT
// EXISTS` so a redeploy on an old or new schema is always a no-op success.
//
// Add new schema changes as new entries at the END of the list.

// ─── Base schema (bootstrap) ────────────────────────────────────────────────
//
// This used to live ONLY in db/init.sql, which docker-compose mounts into the
// Postgres container's entrypoint. That works locally and silently breaks
// production: a managed database (Supabase/Railway/Neon/RDS) never sees that
// file, so the first migration would fail with `relation "rooms" does not
// exist`. Bootstrapping here means "point DATABASE_URL at an empty database
// and start the server" is all it takes.
//
// db/init.sql is kept in sync for local docker-compose users and for anyone
// who prefers to apply the schema by hand.
const BOOTSTRAP: Array<{ sql: string; optional?: boolean }> = [
  // gen_random_uuid() is built into Postgres 13+; this is only for older
  // servers. Some managed plans don't allow CREATE EXTENSION, so it must not
  // be able to abort the boot.
  { sql: `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`, optional: true },

  {
    sql: `CREATE TABLE IF NOT EXISTS rooms (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       name TEXT,
       password_hash TEXT,
       host_participant_id UUID,
       transcription_enabled BOOLEAN DEFAULT true,
       state TEXT DEFAULT 'active',
       created_at TIMESTAMPTZ DEFAULT now(),
       ended_at TIMESTAMPTZ
     )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS participants (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
       name TEXT NOT NULL,
       is_host BOOLEAN DEFAULT false,
       is_muted BOOLEAN DEFAULT false,
       is_camera_off BOOLEAN DEFAULT false,
       joined_at TIMESTAMPTZ DEFAULT now(),
       livekit_identity TEXT UNIQUE,
       user_id TEXT
     )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS chat_messages (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
       participant_id UUID REFERENCES participants(id),
       content TEXT NOT NULL,
       created_at TIMESTAMPTZ DEFAULT now()
     )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS transcript_events (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
       participant_id UUID REFERENCES participants(id),
       text TEXT NOT NULL,
       is_final BOOLEAN DEFAULT false,
       created_at TIMESTAMPTZ DEFAULT now()
     )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS game_rounds (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
       game_type TEXT NOT NULL,
       state TEXT DEFAULT 'open',
       round_data JSONB,
       started_at TIMESTAMPTZ DEFAULT now(),
       ended_at TIMESTAMPTZ
     )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS game_submissions (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       round_id UUID REFERENCES game_rounds(id) ON DELETE CASCADE,
       participant_id UUID REFERENCES participants(id),
       submission JSONB,
       score INTEGER DEFAULT 0,
       created_at TIMESTAMPTZ DEFAULT now(),
       UNIQUE(round_id, participant_id)
     )`,
  },
  // Indexes. NOTE: must be IF NOT EXISTS — these run on every boot.
  { sql: `CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id)` },
  { sql: `CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room_id)` },
  { sql: `CREATE INDEX IF NOT EXISTS idx_transcript_room ON transcript_events(room_id)` },
  { sql: `CREATE INDEX IF NOT EXISTS idx_game_rounds_room ON game_rounds(room_id)` },
  { sql: `CREATE INDEX IF NOT EXISTS idx_game_submissions_round ON game_submissions(round_id)` },
];

const MIGRATIONS: string[] = [
  // 2026-08-06 — host camera-off moderation flag (participant:camera event)
  `ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_camera_off BOOLEAN DEFAULT false`,

  // 2026-08-08 — captions/transcription ON by default (main attraction):
  // new rooms start with transcription enabled so the demo works instantly.
  // Existing rooms are flipped on too — captions are the site's main feature
  // and the host can still toggle off per-room if they want.
  `ALTER TABLE rooms ALTER COLUMN transcription_enabled SET DEFAULT true`,
  `UPDATE rooms SET transcription_enabled = true WHERE transcription_enabled IS NULL OR transcription_enabled = false`,

  // 2026-09-16 — call recordings (LiveKit Egress → S3-compatible bucket).
  // Persisted so the recap page can play the file back; egress finalizes the
  // upload after the room is deleted, so the URL has to outlive the call.
  `CREATE TABLE IF NOT EXISTS room_recordings (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
     egress_id TEXT,
     download_url TEXT,
     filepath TEXT,
     audio_only BOOLEAN DEFAULT false,
     duration_sec INTEGER DEFAULT 0,
     started_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_room_recordings_room ON room_recordings(room_id)`,

  // 2026-09-18 — DURABLE ROOM OWNERSHIP (host-rights bug).
  //
  // host_participant_id is a participant ROW id, and promoteToHost() used to
  // overwrite it whenever an interim host was appointed after the owner dropped.
  // That erased the owner's claim: on rejoin the "host heal" in routes/rooms.ts
  // compares host_participant_id against the returning row, found the interim
  // host's id, and never restored host powers — the owner was demoted for the
  // life of the room. host_user_id is the stable client identity (localStorage),
  // so the owner can be recognised regardless of which row they come back on.
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS host_user_id TEXT`,

  // 2026-09-16 — FIX DELETES BLOCKED BY PARTICIPANT FKs (production bug).
  //
  // chat_messages.participant_id, transcript_events.participant_id and
  // game_submissions.participant_id referenced participants(id) WITHOUT a
  // delete rule. Deleting a room cascades to participants (and to the child
  // rows via their room_id/round_id cascades), but Postgres enforces the
  // participant FK immediately, mid-cascade, and aborts:
  //
  //   update or delete on table "participants" violates foreign key
  //   constraint "...participant_id_fkey" on table "chat_messages"
  //
  // Two real consequences: the abandoned-room privacy purge
  // (cleanup.ts → DELETE FROM rooms) never removed anything, and a host
  // removing a participant mid-meeting failed silently. Rows belonging to a
  // removed participant are deleted with them (same privacy posture as the
  // room purge, and those rows are already unreachable in the recap because
  // the recap joins participants).
  //
  // Guarded by confdeltype: 'c' = CASCADE, so this is a no-op once applied.
  `DO $$
   DECLARE
     ref RECORD;
   BEGIN
     FOR ref IN
       SELECT * FROM (VALUES
         ('chat_messages', 'participant_id', 'chat_messages_participant_id_fkey'),
         ('transcript_events', 'participant_id', 'transcript_events_participant_id_fkey'),
         ('game_submissions', 'participant_id', 'game_submissions_participant_id_fkey')
       ) AS t(tbl, col, conname)
     LOOP
       IF EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = ref.conname AND confdeltype <> 'c'
       ) THEN
         EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', ref.tbl, ref.conname);
         EXECUTE format(
           'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES participants(id) ON DELETE CASCADE',
           ref.tbl, ref.conname, ref.col
         );
         RAISE NOTICE 'meetplay: added ON DELETE CASCADE to %.%', ref.tbl, ref.conname;
       END IF;
     END LOOP;
   END $$`,

  // 2026-09-16 — STOP THE PUBLIC DATA API FROM READING APP TABLES (security).
  //
  // MeetPlay's backend talks to Postgres directly as the table owner, so the
  // Supabase Data API (PostgREST) needs NO access to these tables. Without
  // RLS they were anon-readable — verified against the live project:
  //
  //   GET https://<ref>.supabase.co/rest/v1/transcript_events
  //     apikey: <publishable key>   → HTTP 200  [ ...rows... ]
  //
  // The publishable key is designed to ship inside client bundles (it is in
  // ours), so "anyone with the key" means anyone. For a product holding
  // students' meeting transcripts, chat and recording URLs that is a data
  // breach waiting for the first real session.
  //
  // RLS with NO policies = deny by default for anon/authenticated, while the
  // table owner (our server's role) still bypasses RLS, so the app is
  // unaffected. Deliberately NOT "FORCE ROW LEVEL SECURITY" — that would
  // apply the deny-all to the owner and lock the app out of its own data.
  // On plain Postgres the revoke block is skipped (no such roles).
  `ALTER TABLE rooms ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE participants ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE transcript_events ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE game_rounds ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE game_submissions ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE room_recordings ENABLE ROW LEVEL SECURITY`,
  `DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
        AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
       -- Existing tables.
       REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
       -- And tables added later by this role, so new app tables are not born
       -- exposed (Supabase grants these by default in public).
       ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
       RAISE NOTICE 'meetplay: revoked anon/authenticated access to public tables';
     END IF;
   END $$`,

  // 2026-09-25 — TURN PROVENANCE ON THE PERSISTED TRANSCRIPT (recap bug).
  //
  // A resumed Flux turn arrives as two finals: the eager one in full ("we should
  // ship"), then the refined one carrying only the NEW tail ("it friday"). The
  // tail is the countable payload, so `text` must keep holding exactly that —
  // and the recap page rendered both rows verbatim, one sentence as two lines.
  //
  // The live caption display joins them from the turn identity the adapter
  // stamps on each emission (Utterance.turnText/turnSeq). A row in this table
  // cannot recover that identity from its own text: "the rest of that sentence"
  // and "a new sentence that opens with the same words" are indistinguishable,
  // which is exactly why the merge rule refuses to guess. So the identity is
  // PERSISTED here and the recap merges at read time with the same verified rule
  // (server/src/stt/turnText.ts).
  //
  // Both columns are nullable and additive: rows written before this change keep
  // working (they simply never merge), and `text` is untouched for every counter
  // — word accounting never reads these columns.
  `ALTER TABLE transcript_events ADD COLUMN IF NOT EXISTS turn_text TEXT`,
  `ALTER TABLE transcript_events ADD COLUMN IF NOT EXISTS turn_seq INTEGER`,
];

export async function runMigrations(): Promise<void> {
  // Lazy import so memory-mode deployments never load the `pg` package.
  const { pool } = await import('./pgQueries.js');

  const run = async (sql: string, label: string, optional = false) => {
    try {
      await pool.query(sql);
      console.log(`[migrate] ok: ${label}`);
    } catch (e) {
      if (optional) {
        console.warn(`[migrate] skipped (optional): ${label} - ${(e as Error)?.message ?? e}`);
        return;
      }
      console.error(`[migrate] failed: ${label} - ${(e as Error)?.message ?? e}`);
      throw e;
    }
  };

  // 1. Base schema first — an empty database must become a working one.
  for (const { sql, optional } of BOOTSTRAP) {
    await run(sql, sql.replace(/\s+/g, ' ').slice(0, 90), optional);
  }

  // 2. Incremental changes (idempotent, safe to re-run on every boot).
  for (const sql of MIGRATIONS) {
    await run(sql, sql.replace(/\s+/g, ' ').slice(0, 90));
  }
}
