import { updateRoom, deleteTranscriptEvents } from './db/queries.js';
import { destroyGameEngine } from './games/engine.js';
import { deleteLiveKitRoom } from './livekit/moderation.js';
import { channelManager } from './ws/channels.js';

/**
 * Hard-end a meeting (host power). This is the single source of truth for
 * "end meeting" used by both the WS `room:end` handler and the
 * POST /api/rooms/:id/end route:
 *
 *   1. Mark the room ended (blocks new joins, sends clients to recap)
 *   2. Delete transcripts (recap is built from what's left)
 *   3. Stop the game engine timers
 *   4. DELETE the LiveKit room — this disconnects every media participant
 *      immediately, even clients that missed the WS signal
 *   5. Broadcast `room:ended` and close all WS sockets
 *
 * Idempotent: safe to call twice (e.g. WS + HTTP fallback in parallel).
 */
export async function endMeetingRoom(roomId: string): Promise<void> {
  await updateRoom(roomId, { state: 'ended', ended_at: new Date().toISOString() });
  await deleteTranscriptEvents(roomId);
  destroyGameEngine(roomId);
  await deleteLiveKitRoom(roomId);
  channelManager.broadcast(roomId, { type: 'room:ended', payload: {} });
  channelManager.closeRoom(roomId);
}
