import { withSummary, type RecapBase, type RecapData } from './recapSummary.js';
import { createPool } from './pool.js';
import { mergeTurnRows } from '../stt/turnText.js';

export const pool = createPool();

// ─── Row shapes (typed — pg returns untyped rows, so name them explicitly) ──

interface RoomRow {
  id: string;
  name: string | null;
  password_hash: string | null;
  host_participant_id: string | null;
  /** Stable client identity of the room's owner (survives row churn). */
  host_user_id: string | null;
  transcription_enabled: boolean;
  state: 'active' | 'locked' | 'ended';
  created_at: Date | string;
  ended_at: Date | string | null;
}

interface ParticipantRow {
  id: string;
  room_id: string;
  name: string;
  is_host: boolean;
  is_muted: boolean;
  is_camera_off: boolean;
  joined_at: Date | string;
  livekit_identity: string | null;
  user_id: string | null;
}

interface TranscriptEventRow {
  id: string;
  room_id: string;
  participant_id: string;
  text: string;
  is_final: boolean;
  /** Full text of the turn this row belongs to (resumed turns); display only. */
  turn_text: string | null;
  /** Identity of that turn (see Utterance.turnSeq); display only. */
  turn_seq: number | null;
  created_at: Date | string;
  participant_name: string;
}

interface GameRoundRow {
  id: string;
  room_id: string;
  game_type: string;
  state: string;
  round_data: unknown;
  started_at: Date | string;
  ended_at: Date | string | null;
}

interface GameSubmissionRow {
  id: string;
  round_id: string;
  participant_id: string;
  submission: unknown;
  score: number;
  created_at: Date | string;
  participant_name: string;
}

/** Normalize pg timestamps (Date objects) or stored ISO strings to ISO. */
function toISO(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

// ─── Rooms ────────────────────────────────────────────

export async function createRoom(opts: { name?: string; passwordHash?: string; hostUserId?: string }) {
  const { rows } = await pool.query(
    `INSERT INTO rooms (name, password_hash, host_user_id) VALUES ($1, $2, $3) RETURNING *`,
    [opts.name ?? null, opts.passwordHash ?? null, opts.hostUserId ?? null]
  );
  return rows[0];
}

export async function getRoomById(id: string): Promise<RoomRow | null> {
  const { rows } = await pool.query<RoomRow>(`SELECT * FROM rooms WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function updateRoom(id: string, updates: Record<string, unknown>) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) => updates[k]);
  const { rows } = await pool.query(
    `UPDATE rooms SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0];
}

export async function setRoomHost(roomId: string, participantId: string, hostUserId?: string | null) {
  const { rows } = await pool.query(
    hostUserId === undefined
      ? `UPDATE rooms SET host_participant_id = $2 WHERE id = $1 RETURNING *`
      : `UPDATE rooms SET host_participant_id = $2, host_user_id = COALESCE($3, host_user_id) WHERE id = $1 RETURNING *`,
    hostUserId === undefined ? [roomId, participantId] : [roomId, participantId, hostUserId]
  );
  return rows[0];
}

// ─── Participants ─────────────────────────────────────

export async function addParticipant(opts: {
  roomId: string;
  name: string;
  isHost: boolean;
  userId?: string;
}) {
  const { rows } = await pool.query(
    `INSERT INTO participants (room_id, name, is_host, livekit_identity, user_id)
     VALUES ($1, $2, $3, gen_random_uuid()::text, $4)
     RETURNING *`,
    [opts.roomId, opts.name, opts.isHost, opts.userId ?? null]
  );
  return rows[0];
}

export async function getParticipantsByRoom(roomId: string): Promise<ParticipantRow[]> {
  const { rows } = await pool.query<ParticipantRow>(
    `SELECT * FROM participants WHERE room_id = $1 ORDER BY joined_at`,
    [roomId]
  );
  return rows;
}

export async function getParticipantByRoomAndUser(roomId: string, userId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM participants WHERE room_id = $1 AND user_id = $2 LIMIT 1`,
    [roomId, userId]
  );
  return rows[0] ?? null;
}

export async function getParticipantById(id: string) {
  const { rows } = await pool.query(`SELECT * FROM participants WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Liveness probe for /health: is the database actually answering?
 *
 * One round-trip, no state, and it never throws — the caller turns `false` into a
 * 503. Small enough to survive a saturated pool, so a busy database still reads
 * "up" rather than timing out into a false alarm.
 */
const PING_TIMEOUT_MS = Number(process.env.DB_PING_TIMEOUT_MS ?? 3000) || 3000;

export async function pingDb(): Promise<boolean> {
  try {
    await Promise.race([
      pool.query('select 1'),
      new Promise((_resolve, reject) => {
        const t = setTimeout(() => reject(new Error('ping timeout')), PING_TIMEOUT_MS);
        // Do not keep the event loop alive just for a health probe.
        (t as { unref?: () => void }).unref?.();
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function removeParticipant(id: string) {
  await pool.query(`DELETE FROM participants WHERE id = $1`, [id]);
}

export async function promoteToHost(
  participantId: string,
  opts: { claimOwnership?: boolean } = {}
) {
  // First reset all hosts in the room
  const participant = await getParticipantById(participantId);
  if (!participant) return null;
  await pool.query(
    `UPDATE participants SET is_host = false WHERE room_id = $1`,
    [participant.room_id]
  );
  // Promote the new host
  const { rows } = await pool.query(
    `UPDATE participants SET is_host = true WHERE id = $1 RETURNING *`,
    [participantId]
  );
  // An INTERIM host (appointed because the owner dropped) must not claim
  // ownership: host_participant_id keeps pointing at the owner so they are
  // recognised — and restored — when they come back.
  if (opts.claimOwnership !== false) {
    await setRoomHost(participant.room_id, participantId);
  }
  return rows[0];
}

export async function getFirstParticipant(roomId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM participants WHERE room_id = $1 ORDER BY joined_at LIMIT 1`,
    [roomId]
  );
  return rows[0] ?? null;
}

export async function updateParticipantMuted(id: string, isMuted: boolean) {
  const { rows } = await pool.query(
    `UPDATE participants SET is_muted = $2 WHERE id = $1 RETURNING *`,
    [id, isMuted]
  );
  return rows[0];
}

export async function updateParticipantCamera(id: string, isCameraOff: boolean) {
  const { rows } = await pool.query(
    `UPDATE participants SET is_camera_off = $2 WHERE id = $1 RETURNING *`,
    [id, isCameraOff]
  );
  return rows[0];
}

// ─── Chat ─────────────────────────────────────────────

export async function saveChatMessage(opts: {
  roomId: string;
  participantId: string;
  content: string;
}) {
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (room_id, participant_id, content)
     VALUES ($1, $2, $3) RETURNING *`,
    [opts.roomId, opts.participantId, opts.content]
  );
  return rows[0];
}

export async function getChatMessages(roomId: string) {
  const { rows } = await pool.query(
    `SELECT cm.*, p.name AS participant_name
     FROM chat_messages cm
     JOIN participants p ON p.id = cm.participant_id
     WHERE cm.room_id = $1
     ORDER BY cm.created_at`,
    [roomId]
  );
  return rows;
}

// ─── Transcript ───────────────────────────────────────

export async function saveTranscriptEvent(opts: {
  roomId: string;
  participantId: string;
  text: string;
  isFinal: boolean;
  /** Full text of the turn (resumed turns); never used for counting. */
  turnText?: string;
  /** Identity of the turn (see Utterance.turnSeq). */
  turnSeq?: number;
}) {
  const { rows } = await pool.query(
    `INSERT INTO transcript_events (room_id, participant_id, text, is_final, turn_text, turn_seq)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [opts.roomId, opts.participantId, opts.text, opts.isFinal, opts.turnText ?? null, opts.turnSeq ?? null]
  );
  return rows[0];
}

export async function getTranscriptEvents(roomId: string): Promise<TranscriptEventRow[]> {
  const { rows } = await pool.query<TranscriptEventRow>(
    `SELECT te.*, p.name AS participant_name
     FROM transcript_events te
     JOIN participants p ON p.id = te.participant_id
     WHERE te.room_id = $1 AND te.is_final = true
     ORDER BY te.created_at`,
    [roomId]
  );
  return rows;
}

export async function deleteTranscriptEvents(roomId: string) {
  await pool.query(`DELETE FROM transcript_events WHERE room_id = $1`, [roomId]);
}

// ─── Game Rounds ──────────────────────────────────────

export async function createGameRound(opts: {
  roomId: string;
  gameType: string;
  roundData: unknown;
}) {
  const { rows } = await pool.query(
    `INSERT INTO game_rounds (room_id, game_type, round_data)
     VALUES ($1, $2, $3) RETURNING *`,
    [opts.roomId, opts.gameType, JSON.stringify(opts.roundData)]
  );
  return rows[0];
}

export async function getGameRounds(roomId: string): Promise<GameRoundRow[]> {
  const { rows } = await pool.query<GameRoundRow>(
    `SELECT * FROM game_rounds WHERE room_id = $1 ORDER BY started_at`,
    [roomId]
  );
  return rows;
}

export async function updateGameRound(id: string, updates: Record<string, unknown>) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) => updates[k]);
  const { rows } = await pool.query(
    `UPDATE game_rounds SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0];
}

// ─── Game Submissions ─────────────────────────────────

export async function saveGameSubmission(opts: {
  roundId: string;
  participantId: string;
  submission: unknown;
  score: number;
}) {
  const { rows } = await pool.query(
    `INSERT INTO game_submissions (round_id, participant_id, submission, score)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (round_id, participant_id)
     DO UPDATE SET submission = EXCLUDED.submission, score = EXCLUDED.score
     RETURNING *`,
    [opts.roundId, opts.participantId, JSON.stringify(opts.submission), opts.score]
  );
  return rows[0];
}

export async function getGameSubmissions(roundId: string): Promise<GameSubmissionRow[]> {
  const { rows } = await pool.query<GameSubmissionRow>(
    `SELECT gs.*, p.name AS participant_name
     FROM game_submissions gs
     JOIN participants p ON p.id = gs.participant_id
     WHERE gs.round_id = $1
     ORDER BY gs.created_at`,
    [roundId]
  );
  return rows;
}

// ─── Room recordings (LiveKit Egress output) ───────────

/**
 * Persist a finalized recording. Called from both stop paths (host stops,
 * or the meeting ends while recording) so the recap page can play it back —
 * egress finishes writing AFTER the room is gone, so the result can't live
 * only in memory.
 */
export async function saveRoomRecording(opts: {
  roomId: string;
  egressId?: string | null;
  downloadUrl?: string | null;
  filepath?: string | null;
  audioOnly?: boolean;
  durationSec?: number;
  startedAt?: number | null;
}) {
  const { rows } = await pool.query(
    `INSERT INTO room_recordings
       (room_id, egress_id, download_url, filepath, audio_only, duration_sec, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      opts.roomId,
      opts.egressId ?? null,
      opts.downloadUrl ?? null,
      opts.filepath ?? null,
      opts.audioOnly ?? false,
      opts.durationSec ?? 0,
      opts.startedAt ? new Date(opts.startedAt).toISOString() : null,
    ]
  );
  return rows[0];
}

interface RoomRecordingRow {
  id: string;
  download_url: string | null;
  filepath: string | null;
  audio_only: boolean;
  duration_sec: number;
  started_at: Date | string | null;
  created_at: Date | string;
}

/** Recordings for a room, newest first. Audio-only files are skipped by the
 *  video player but still returned (the recap offers them as audio). */
export async function getRoomRecordings(roomId: string): Promise<RoomRecordingRow[]> {
  const { rows } = await pool.query<RoomRecordingRow>(
    `SELECT * FROM room_recordings WHERE room_id = $1 ORDER BY created_at DESC`,
    [roomId]
  );
  return rows;
}

// ─── Recap ────────────────────────────────────────────
// getRecap assembles raw rows into the shared RecapBase shape, then delegates
// leaderboard + key-quotes scoring to the single shared `withSummary` in
// recapSummary.ts (both DB backends call the same code — one scoring source).

export type { RecapData, RoomRecording } from './recapSummary.js';

export async function getRecap(roomId: string): Promise<RecapData | null> {
  const room = await getRoomById(roomId);
  if (!room) return null;
  const participants = await getParticipantsByRoom(roomId);
  const transcript = await getTranscriptEvents(roomId);
  const gameRounds = await getGameRounds(roomId);
  const recordings = await getRoomRecordings(roomId);

  const gameRoundsWithSubs: RecapBase['gameRounds'] = await Promise.all(
    gameRounds.map(async (gr) => {
      const submissions = await getGameSubmissions(gr.id);
      return {
        id: gr.id,
        gameType: gr.game_type,
        roundData: gr.round_data,
        startedAt: toISO(gr.started_at) ?? '',
        endedAt: toISO(gr.ended_at),
        state: gr.state,
        submissions: submissions.map((s) => ({
          participantId: s.participant_id,
          participantName: s.participant_name,
          submission: s.submission,
          score: s.score,
        })),
      };
    })
  );

  const started = new Date(room.created_at).getTime();
  const ended = room.ended_at ? new Date(room.ended_at).getTime() : Date.now();
  const durationSec = Math.floor((ended - started) / 1000);

  const recapBase: RecapBase = {
    room: {
      id: room.id,
      name: room.name,
      createdAt: toISO(room.created_at) ?? '',
      endedAt: toISO(room.ended_at),
      duration: durationSec,
    },
    participants: participants.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.is_host,
      joinedAt: toISO(p.joined_at) ?? '',
    })),
    transcript: mergeTurnRows(
      transcript.map((t) => ({
        id: t.id,
        participantName: t.participant_name,
        speakerId: t.participant_id,
        text: t.text,
        turnText: t.turn_text ?? undefined,
        turnSeq: t.turn_seq ?? undefined,
        createdAt: toISO(t.created_at) ?? '',
      }))
    ).map((t) => ({
      id: t.id,
      participantName: t.participantName,
      text: t.text,
      createdAt: t.createdAt,
    })),
    gameRounds: gameRoundsWithSubs,
    recordings: recordings.map((r) => ({
      id: r.id,
      downloadUrl: r.download_url,
      filepath: r.filepath,
      audioOnly: r.audio_only,
      durationSec: r.duration_sec,
      startedAt: toISO(r.started_at),
      createdAt: toISO(r.created_at) ?? '',
    })),
  };

  return withSummary(recapBase);
}

// ─── Abandoned-room cleanup ────────────────────────────────

/**
 * Purge rooms that were created but abandoned (never ended): state is still
 * 'active' and no activity of any kind (chat, transcript, participant join,
 * game round) occurred within maxAgeHours. FK ON DELETE CASCADE removes
 * participants, chat, transcripts, game rounds and submissions. Returns the
 * purged room ids.
 */
export async function cleanupAbandonedRooms(maxAgeHours = 24): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `DELETE FROM rooms r
     WHERE r.state = 'active'
       AND GREATEST(
         r.created_at,
         COALESCE((SELECT MAX(m.created_at) FROM chat_messages m WHERE m.room_id = r.id), r.created_at),
         COALESCE((SELECT MAX(t.created_at) FROM transcript_events t WHERE t.room_id = r.id), r.created_at),
         COALESCE((SELECT MAX(p.joined_at) FROM participants p WHERE p.room_id = r.id), r.created_at),
         COALESCE((SELECT MAX(COALESCE(g.ended_at, g.started_at)) FROM game_rounds g WHERE g.room_id = r.id), r.created_at)
       ) < NOW() - ($1::int * INTERVAL '1 hour')
     RETURNING id`,
    [maxAgeHours]
  );
  return rows.map((r) => r.id);
}
