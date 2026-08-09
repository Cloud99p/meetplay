import { v4 as uuid } from 'uuid';
import { withSummary, type RecapBase, type RecapData } from './recapSummary.js';

// ─── Types ──────────────────────────────────────────────────

export interface RoomRow {
  id: string;
  name: string | null;
  password_hash: string | null;
  host_participant_id: string | null;
  transcription_enabled: boolean;
  state: 'active' | 'locked' | 'ended';
  created_at: string;
  ended_at: string | null;
}

export interface ParticipantRow {
  id: string;
  room_id: string;
  name: string;
  is_host: boolean;
  is_muted: boolean;
  is_camera_off: boolean;
  joined_at: string;
  livekit_identity: string | null;
  user_id: string | null;
}

export interface ChatMessageRow {
  id: string;
  room_id: string;
  participant_id: string;
  content: string;
  created_at: string;
}

export interface TranscriptEventRow {
  id: string;
  room_id: string;
  participant_id: string;
  text: string;
  is_final: boolean;
  created_at: string;
}

export interface GameRoundRow {
  id: string;
  room_id: string;
  game_type: string;
  state: string;
  round_data: unknown;
  started_at: string;
  ended_at: string | null;
}

export interface GameSubmissionRow {
  id: string;
  round_id: string;
  participant_id: string;
  submission: unknown;
  score: number;
  created_at: string;
}

// ─── In-memory store ────────────────────────────────────────

class InMemoryStore {
  rooms = new Map<string, RoomRow>();
  participants = new Map<string, ParticipantRow>();
  chatMessages = new Map<string, ChatMessageRow>();
  transcriptEvents = new Map<string, TranscriptEventRow>();
  gameRounds = new Map<string, GameRoundRow>();
  gameSubmissions = new Map<string, GameSubmissionRow>();
}

const store = new InMemoryStore();

function nowISO(): string {
  return new Date().toISOString();
}

// ─── Rooms ──────────────────────────────────────────────────

export async function createRoom(opts: { name?: string; passwordHash?: string }) {
  const id = uuid();
  const row: RoomRow = {
    id,
    name: opts.name ?? null,
    password_hash: opts.passwordHash ?? null,
    host_participant_id: null,
    transcription_enabled: true,
    state: 'active',
    created_at: nowISO(),
    ended_at: null,
  };
  store.rooms.set(id, row);
  return row;
}

export async function getRoomById(id: string) {
  return store.rooms.get(id) ?? null;
}

export async function updateRoom(id: string, updates: Record<string, unknown>) {
  const row = store.rooms.get(id);
  if (!row) return;
  for (const [key, value] of Object.entries(updates)) {
    (row as any)[key] = value;
  }
  return row;
}

export async function setRoomHost(roomId: string, participantId: string) {
  const row = store.rooms.get(roomId);
  if (!row) return;
  row.host_participant_id = participantId;
  return row;
}

// ─── Participants ───────────────────────────────────────────

export async function addParticipant(opts: {
  roomId: string;
  name: string;
  isHost: boolean;
  userId?: string;
}) {
  const id = uuid();
  const row: ParticipantRow = {
    id,
    room_id: opts.roomId,
    name: opts.name,
    is_host: opts.isHost,
    is_muted: false,
    is_camera_off: false,
    joined_at: nowISO(),
    livekit_identity: uuid(),
    user_id: opts.userId ?? null,
  };
  store.participants.set(id, row);
  return row;
}

export async function getParticipantsByRoom(roomId: string) {
  const rows: ParticipantRow[] = [];
  for (const p of store.participants.values()) {
    if (p.room_id === roomId) rows.push(p);
  }
  rows.sort((a, b) => a.joined_at.localeCompare(b.joined_at));
  return rows;
}

export async function getParticipantByRoomAndUser(roomId: string, userId: string) {
  for (const p of store.participants.values()) {
    if (p.room_id === roomId && p.user_id === userId) return p;
  }
  return null;
}

export async function getParticipantById(id: string) {
  return store.participants.get(id) ?? null;
}

export async function removeParticipant(id: string) {
  store.participants.delete(id);
}

export async function promoteToHost(participantId: string) {
  const participant = await getParticipantById(participantId);
  if (!participant) return null;

  // Reset all hosts in the room
  for (const p of store.participants.values()) {
    if (p.room_id === participant.room_id) {
      p.is_host = false;
    }
  }

  // Promote the new host
  participant.is_host = true;
  await setRoomHost(participant.room_id, participantId);
  return participant;
}

export async function getFirstParticipant(roomId: string) {
  const participants = await getParticipantsByRoom(roomId);
  return participants[0] ?? null;
}

export async function updateParticipantMuted(id: string, isMuted: boolean) {
  const p = store.participants.get(id);
  if (!p) return null;
  p.is_muted = isMuted;
  return p;
}

export async function updateParticipantCamera(id: string, isCameraOff: boolean) {
  const p = store.participants.get(id);
  if (!p) return null;
  p.is_camera_off = isCameraOff;
  return p;
}

// ─── Chat ───────────────────────────────────────────────────

export async function saveChatMessage(opts: {
  roomId: string;
  participantId: string;
  content: string;
}) {
  const id = uuid();
  const row: ChatMessageRow = {
    id,
    room_id: opts.roomId,
    participant_id: opts.participantId,
    content: opts.content,
    created_at: nowISO(),
  };
  store.chatMessages.set(id, row);
  return row;
}

export async function getChatMessages(roomId: string) {
  const rows: ChatMessageRow[] = [];
  for (const m of store.chatMessages.values()) {
    if (m.room_id === roomId) rows.push(m);
  }
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Join participant name
  return rows.map((m) => {
    const p = store.participants.get(m.participant_id);
    return { ...m, participant_name: p?.name ?? 'Unknown' };
  });
}

// ─── Transcript ─────────────────────────────────────────────

export async function saveTranscriptEvent(opts: {
  roomId: string;
  participantId: string;
  text: string;
  isFinal: boolean;
}) {
  const id = uuid();
  const row: TranscriptEventRow = {
    id,
    room_id: opts.roomId,
    participant_id: opts.participantId,
    text: opts.text,
    is_final: opts.isFinal,
    created_at: nowISO(),
  };
  store.transcriptEvents.set(id, row);
  return row;
}

export async function getTranscriptEvents(roomId: string) {
  const rows: TranscriptEventRow[] = [];
  for (const t of store.transcriptEvents.values()) {
    if (t.room_id === roomId && t.is_final) rows.push(t);
  }
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return rows.map((t) => {
    const p = store.participants.get(t.participant_id);
    return { ...t, participant_name: p?.name ?? 'Unknown' };
  });
}

export async function deleteTranscriptEvents(roomId: string) {
  for (const [id, t] of store.transcriptEvents) {
    if (t.room_id === roomId) store.transcriptEvents.delete(id);
  }
}

/**
 * Purge rooms that were created but abandoned (never ended): state is still
 * 'active' and NO activity of any kind (chat, transcript, participant join,
 * game round) has occurred within the last maxAgeHours. Deletes the room and
 * ALL related rows (cascade semantics like Postgres FK ON DELETE CASCADE).
 * Returns the purged room ids.
 */
export async function cleanupAbandonedRooms(maxAgeHours = 24): Promise<string[]> {
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const stale: string[] = [];

  for (const room of store.rooms.values()) {
    if (room.state !== 'active') continue;
    let last = new Date(room.created_at).getTime();
    for (const m of store.chatMessages.values()) {
      if (m.room_id === room.id) last = Math.max(last, new Date(m.created_at).getTime());
    }
    for (const t of store.transcriptEvents.values()) {
      if (t.room_id === room.id) last = Math.max(last, new Date(t.created_at).getTime());
    }
    for (const p of store.participants.values()) {
      if (p.room_id === room.id) last = Math.max(last, new Date(p.joined_at).getTime());
    }
    for (const g of store.gameRounds.values()) {
      if (g.room_id === room.id) last = Math.max(last, new Date(g.ended_at ?? g.started_at).getTime());
    }
    if (last < cutoff) stale.push(room.id);
  }

  for (const roomId of stale) {
    store.rooms.delete(roomId);
    for (const [id, p] of store.participants) if (p.room_id === roomId) store.participants.delete(id);
    for (const [id, m] of store.chatMessages) if (m.room_id === roomId) store.chatMessages.delete(id);
    for (const [id, t] of store.transcriptEvents) if (t.room_id === roomId) store.transcriptEvents.delete(id);
    const roundIds: string[] = [];
    for (const [id, g] of store.gameRounds) {
      if (g.room_id === roomId) {
        roundIds.push(id);
        store.gameRounds.delete(id);
      }
    }
    for (const [id, s] of store.gameSubmissions) {
      if (roundIds.includes(s.round_id)) store.gameSubmissions.delete(id);
    }
  }
  return stale;
}

// ─── Game Rounds ────────────────────────────────────────────

export async function createGameRound(opts: {
  roomId: string;
  gameType: string;
  roundData: unknown;
}) {
  const id = uuid();
  const row: GameRoundRow = {
    id,
    room_id: opts.roomId,
    game_type: opts.gameType,
    state: 'open',
    round_data: opts.roundData,
    started_at: nowISO(),
    ended_at: null,
  };
  store.gameRounds.set(id, row);
  return row;
}

export async function getGameRounds(roomId: string) {
  const rows: GameRoundRow[] = [];
  for (const g of store.gameRounds.values()) {
    if (g.room_id === roomId) rows.push(g);
  }
  rows.sort((a, b) => a.started_at.localeCompare(b.started_at));
  return rows;
}

export async function updateGameRound(id: string, updates: Record<string, unknown>) {
  const row = store.gameRounds.get(id);
  if (!row) return;
  for (const [key, value] of Object.entries(updates)) {
    (row as any)[key] = value;
  }
  return row;
}

// ─── Game Submissions ───────────────────────────────────────

export async function saveGameSubmission(opts: {
  roundId: string;
  participantId: string;
  submission: unknown;
  score: number;
}) {
  const id = uuid();
  const row: GameSubmissionRow = {
    id,
    round_id: opts.roundId,
    participant_id: opts.participantId,
    submission: opts.submission,
    score: opts.score,
    created_at: nowISO(),
  };
  // ON CONFLICT (round_id, participant_id) DO UPDATE — simulate upsert
  const existingKey = findSubmission(opts.roundId, opts.participantId);
  if (existingKey) {
    const existing = store.gameSubmissions.get(existingKey)!;
    existing.submission = opts.submission;
    existing.score = opts.score;
    return existing;
  }
  store.gameSubmissions.set(id, row);
  return row;
}

function findSubmission(roundId: string, participantId: string): string | null {
  for (const [key, s] of store.gameSubmissions) {
    if (s.round_id === roundId && s.participant_id === participantId) return key;
  }
  return null;
}

export async function getGameSubmissions(roundId: string) {
  const rows: GameSubmissionRow[] = [];
  for (const s of store.gameSubmissions.values()) {
    if (s.round_id === roundId) rows.push(s);
  }
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return rows.map((s) => {
    const p = store.participants.get(s.participant_id);
    return { ...s, participant_name: p?.name ?? 'Unknown' };
  });
}

// ─── Recap ───────────────────────────────────────────────────
// getRecap assembles the raw rows into the shared RecapBase shape, then
// delegates leaderboard + key-quotes scoring to the single shared
// `withSummary` in recapSummary.ts (both DB backends call the same code).

export type { RecapData } from './recapSummary.js';

export async function getRecap(roomId: string): Promise<RecapData | null> {
  const room = await getRoomById(roomId);
  if (!room) return null;

  const participants = await getParticipantsByRoom(roomId);
  const transcript = await getTranscriptEvents(roomId);
  const gameRounds = await getGameRounds(roomId);

  const gameRoundsWithSubs: RecapBase['gameRounds'] = await Promise.all(
    gameRounds.map(async (gr) => {
      const submissions = await getGameSubmissions(gr.id);
      return {
        id: gr.id,
        gameType: gr.game_type,
        roundData: gr.round_data,
        startedAt: gr.started_at,
        endedAt: gr.ended_at,
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
      createdAt: room.created_at,
      endedAt: room.ended_at,
      duration: durationSec,
    },
    participants: participants.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.is_host,
      joinedAt: p.joined_at,
    })),
    transcript: transcript.map((t) => ({
      id: t.id,
      participantName: t.participant_name,
      text: t.text,
      createdAt: t.created_at,
    })),
    gameRounds: gameRoundsWithSubs,
  };

  return withSummary(recapBase);
}