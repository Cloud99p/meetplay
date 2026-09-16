-- =============================================================================
-- MeetPlay — full Postgres schema for Supabase (paste-and-run)
-- =============================================================================
--
-- HOW TO USE
--   1. Supabase dashboard -> SQL Editor -> New query
--   2. Paste this whole file, press Run.
--   3. Run it on a NEW project (creates everything) or on an existing one
--      (every statement is idempotent — a no-op that leaves data alone).
--
-- The backend creates this same schema automatically at boot
-- (server/src/db/migrate.ts). This file exists so the schema can also be
-- applied by hand: new project, restored project, or verifying what the app
-- expects. Keep the two in sync when adding tables.
--
-- WHAT IT CREATES: 7 tables, 15 indexes, a Data-API lockdown (RLS + revokes).
-- CONNECT FROM THE APP with the SESSION POOLER URI and USE_MEMORY_DB=0 — the
-- direct db.<ref>.supabase.co host is IPv6-only on the free tier and the
-- 6543 transaction pooler breaks migrations/backups.
--
-- ORDER MATTERS: tables -> indexes -> security. Do not split it up.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Extension — gen_random_uuid() for primary keys
--    (built into Postgres 13+; on some managed plans CREATE EXTENSION is not
--    permitted, in which case this line is the only one you may need to drop)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Tables
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  password_hash TEXT,
  host_participant_id UUID,
  transcription_enabled BOOLEAN DEFAULT true,
  state TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_host BOOLEAN DEFAULT false,
  is_muted BOOLEAN DEFAULT false,
  is_camera_off BOOLEAN DEFAULT false,
  joined_at TIMESTAMPTZ DEFAULT now(),
  livekit_identity TEXT UNIQUE,
  user_id TEXT
);

-- Child rows carry ON DELETE CASCADE on BOTH FKs. This matters: without the
-- participant_id delete rule, deleting a room (the 24h privacy purge) and
-- removing a participant mid-meeting both abort with an FK violation.
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES participants(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transcript_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES participants(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  is_final BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  game_type TEXT NOT NULL,
  state TEXT DEFAULT 'open',
  round_data JSONB,
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS game_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID REFERENCES game_rounds(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES participants(id) ON DELETE CASCADE,
  submission JSONB,
  score INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(round_id, participant_id)
);

-- LiveKit Egress recordings (a room can be recorded more than once). Kept so
-- the recap page can offer playback: egress finishes uploading AFTER the room
-- is deleted, so a memory-only result would be gone by the time recap loads.
CREATE TABLE IF NOT EXISTS room_recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  egress_id TEXT,
  download_url TEXT,
  filepath TEXT,
  audio_only BOOLEAN DEFAULT false,
  duration_sec INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Repairs for databases created before 2026-09-16
--    (no-ops on a fresh project — safe either way)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_camera_off BOOLEAN DEFAULT false;

-- Captions are the product's main feature: new rooms default to ON, and rooms
-- still carrying the old NULL/false are flipped on (the host can toggle off).
ALTER TABLE rooms ALTER COLUMN transcription_enabled SET DEFAULT true;
UPDATE rooms SET transcription_enabled = true
  WHERE transcription_enabled IS NULL OR transcription_enabled = false;

-- Add the missing ON DELETE CASCADE to the participant FKs. Guarded on
-- pg_constraint.confdeltype ('c' = CASCADE), so re-running is a no-op.
DO $$
DECLARE
  ref RECORD;
BEGIN
  FOR ref IN
    SELECT * FROM (VALUES
      ('chat_messages',     'participant_id', 'chat_messages_participant_id_fkey'),
      ('transcript_events', 'participant_id', 'transcript_events_participant_id_fkey'),
      ('game_submissions',  'participant_id', 'game_submissions_participant_id_fkey')
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
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_participants_room      ON participants(room_id);
CREATE INDEX IF NOT EXISTS idx_chat_room              ON chat_messages(room_id);
CREATE INDEX IF NOT EXISTS idx_transcript_room        ON transcript_events(room_id);
CREATE INDEX IF NOT EXISTS idx_game_rounds_room       ON game_rounds(room_id);
CREATE INDEX IF NOT EXISTS idx_game_submissions_round ON game_submissions(round_id);
CREATE INDEX IF NOT EXISTS idx_room_recordings_room   ON room_recordings(room_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Security — shut the public Data API out of the app tables
-- ─────────────────────────────────────────────────────────────────────────────
-- Supabase grants anon/authenticated access to public tables by default, and
-- the publishable key ships inside client bundles (ours included). Before this
-- lockdown, `GET /rest/v1/transcript_events` with that key returned HTTP 200 —
-- student transcripts, chat and recording URLs would have been world-readable.
--
-- RLS with NO policies = deny-by-default for anon/authenticated, while the
-- table owner (the app's role) still bypasses RLS, so the backend is unaffected.
-- Deliberately NOT "FORCE ROW LEVEL SECURITY": that applies the deny-all to the
-- owner too and would lock the app out of its own data.
--
-- On plain Postgres the revoke block is skipped (those roles don't exist).
ALTER TABLE rooms              ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants       ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_rounds        ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_submissions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_recordings    ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- Existing tables...
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    -- ...and tables created later by this role, so new app tables (accounts,
    -- orgs, ...) are never born exposed.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    RAISE NOTICE 'meetplay: revoked anon/authenticated access to public tables';
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Verification — the query results should show 7 tables, rls = true,
--    15 indexes, and 0 anon/authenticated grants.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT c.relname            AS table_name,
       c.relrowsecurity     AS rls_enabled,
       c.relforcerowsecurity AS force_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;

SELECT count(*)::int AS public_indexes
FROM pg_indexes WHERE schemaname = 'public';

SELECT grantee, count(*)::int AS table_grants
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
GROUP BY grantee;
-- Expect: no rows above. Any row means the Data API can still read that table.
