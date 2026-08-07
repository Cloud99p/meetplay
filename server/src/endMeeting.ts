import { updateRoom, deleteTranscriptEvents } from './db/queries.js';
import { getGameEngine, destroyGameEngine } from './games/engine.js';
import { deleteLiveKitRoom } from './livekit/moderation.js';
import { stopRecordingForRoomEnd } from './livekit/recording.js';
import { channelManager } from './ws/channels.js';

/**
 * Hard-end a meeting (host power). This is the single source of truth for
 * "end meeting" used by both the WS `room:end` handler and the
 * POST /api/rooms/:id/end route:
 *
 *   1. Mark the room ended (blocks new joins, sends clients to recap)
 *   2. Resolve the Word Count market (broadcast final odds + scores)
 *   3. Generate + persist the recap quiz (needs the in-memory buffer)
 *   4. Delete transcripts (recap is built from what's left)
 *   5. Stop the game engine timers
 *   6. DELETE the LiveKit room — this disconnects every media participant
 *      immediately, even clients that missed the WS signal
 *   7. Broadcast `room:ended` and close all WS sockets
 *
 * Idempotent: safe to call twice (e.g. WS + HTTP fallback in parallel).
 * Market resolution and quiz generation are internally guarded.
 */
export async function endMeetingRoom(roomId: string): Promise<void> {
  await updateRoom(roomId, { state: 'ended', ended_at: new Date().toISOString() });
  // Resolve the call-long market + generate the recap quiz while the engine
  // and its utterance buffer are still alive.
  const engine = getGameEngine(roomId);
  await engine.resolveMarket();
  await engine.saveRecapQuiz();
  await deleteTranscriptEvents(roomId);
  destroyGameEngine(roomId);
  // Finalize any live recording before the room is deleted (egress needs the
  // room alive to finish writing the file).
  await stopRecordingForRoomEnd(roomId);
  await deleteLiveKitRoom(roomId);
  channelManager.broadcast(roomId, { type: 'room:ended', payload: {} });
  channelManager.closeRoom(roomId);
}
