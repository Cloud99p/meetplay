// Database query layer.
//
// Picks the backend automatically:
//  - If `DATABASE_URL` is set (and USE_MEMORY_DB is not '1'), uses PostgreSQL via pg.
//  - Otherwise uses an in-memory store so the app runs with zero external
//    dependencies (ideal for local preview / dev sandboxes).

// Import the Postgres implementation lazily so the app runs fully in-memory
// (preview / local dev) without the `pg` package being installed.
const USE_MEMORY = !process.env.DATABASE_URL || process.env.USE_MEMORY_DB === '1';

const impl = USE_MEMORY
  ? await import('./memory.js')
  : await import('./pgQueries.js');

// ─── Rooms ──────────────────────────────────────────────────

export const createRoom = impl.createRoom;
export const getRoomById = impl.getRoomById;
export const updateRoom = impl.updateRoom;
export const setRoomHost = impl.setRoomHost;

// ─── Participants ───────────────────────────────────────────

export const addParticipant = impl.addParticipant;
export const getParticipantsByRoom = impl.getParticipantsByRoom;
export const getParticipantByRoomAndUser = impl.getParticipantByRoomAndUser;
export const getParticipantById = impl.getParticipantById;
export const removeParticipant = impl.removeParticipant;
export const promoteToHost = impl.promoteToHost;
export const getFirstParticipant = impl.getFirstParticipant;
export const updateParticipantMuted = impl.updateParticipantMuted;
export const updateParticipantCamera = impl.updateParticipantCamera;

// ─── Chat ───────────────────────────────────────────────────

export const saveChatMessage = impl.saveChatMessage;
export const getChatMessages = impl.getChatMessages;

// ─── Transcript ─────────────────────────────────────────────

export const saveTranscriptEvent = impl.saveTranscriptEvent;
export const getTranscriptEvents = impl.getTranscriptEvents;
export const deleteTranscriptEvents = impl.deleteTranscriptEvents;

// ─── Abandoned-room cleanup ─────────────────────────────────

export const cleanupAbandonedRooms = impl.cleanupAbandonedRooms;

// ─── Game Rounds ────────────────────────────────────────────

export const createGameRound = impl.createGameRound;
export const getGameRounds = impl.getGameRounds;
export const updateGameRound = impl.updateGameRound;

// ─── Game Submissions ───────────────────────────────────────

export const saveGameSubmission = impl.saveGameSubmission;
export const getGameSubmissions = impl.getGameSubmissions;

// ─── Recap ──────────────────────────────────────────────────

export const getRecap = impl.getRecap;
export type RecapData = import('./memory.js').RecapData;
