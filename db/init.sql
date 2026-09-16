CREATE EXTENSION IF NOT EXISTS "pgcrypto";

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

-- Idempotent migration for existing deployments (re-running init.sql is safe)
ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_camera_off BOOLEAN DEFAULT false;

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

-- LiveKit Egress recordings (one room can be recorded several times).
-- Stored so the recap page can offer inline playback: the recording is
-- usually finalized AFTER the room is deleted, so an in-memory-only result
-- would be lost by the time the recap loads.
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

CREATE INDEX IF NOT EXISTS idx_room_recordings_room ON room_recordings(room_id);

CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);
CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room_id);
CREATE INDEX IF NOT EXISTS idx_transcript_room ON transcript_events(room_id);
CREATE INDEX IF NOT EXISTS idx_game_rounds_room ON game_rounds(room_id);
CREATE INDEX IF NOT EXISTS idx_game_submissions_round ON game_submissions(round_id);