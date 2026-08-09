import { cleanupAbandonedRooms } from './db/queries.js';
import { destroyGameEngine } from './games/engine.js';
import { channelManager } from './ws/channels.js';
import { omniClient } from './intelligence/omniClient.js';

/**
 * Abandoned-room data retention policy.
 *
 * Rooms only delete their transcript on explicit /end. A room that's created
 * and simply abandoned (browser closed, host never pressed End) would keep
 * its chat + transcript in Postgres forever — a real privacy gap for an app
 * whose README promises transcription is scoped to the meeting.
 *
 * This job periodically deletes rooms that are still 'active' but have seen
 * NO activity (chat, transcript, participant join, game round) within the
 * retention window. FK cascades remove all related rows in Postgres; the
 * in-memory store mirrors that. Game engines + WS channels + Omnilearn graph
 * nodes for purged rooms are torn down too.
 *
 * Tunables (env):
 *   ROOM_RETENTION_HOURS    default 24 — max idle age before purge
 *   ROOM_CLEANUP_INTERVAL_MS default 60 min — how often the job runs
 */

const RETENTION_HOURS = Number(process.env.ROOM_RETENTION_HOURS ?? 24);
const INTERVAL_MS = Number(process.env.ROOM_CLEANUP_INTERVAL_MS ?? 60 * 60 * 1000);

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function runRoomCleanup(): Promise<string[]> {
  if (running) return [];
  running = true;
  try {
    const purged = await cleanupAbandonedRooms(RETENTION_HOURS);
    for (const roomId of purged) {
      try {
        destroyGameEngine(roomId);
      } catch {
        /* ignore */
      }
      channelManager.closeRoom(roomId);
      omniClient.flushRoom(roomId).catch(() => {});
      omniClient.deleteMeeting(roomId).catch(() => {});
    }
    if (purged.length > 0) {
      console.log(`[cleanup] purged ${purged.length} abandoned room(s) (idle > ${RETENTION_HOURS}h): ${purged.join(', ')}`);
    }
    return purged;
  } catch (e) {
    console.error('[cleanup] run failed:', (e as Error)?.message ?? e);
    return [];
  } finally {
    running = false;
  }
}

/** Start the periodic cleanup job. Safe to call multiple times (idempotent). */
export function startRoomCleanup(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runRoomCleanup();
  }, INTERVAL_MS);
  timer.unref?.();
  console.log(
    `[cleanup] started — purge rooms idle > ${RETENTION_HOURS}h, every ${Math.round(INTERVAL_MS / 60000)} min`,
  );
}

/** Stop the job (tests / shutdown). */
export function stopRoomCleanup(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
