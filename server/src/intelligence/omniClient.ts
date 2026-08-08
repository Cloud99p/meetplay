/**
 * omniClient.ts — MeetPlay ⇄ Omnilearn integration client.
 *
 * Records meeting transcript utterances into the Omnilearn knowledge graph
 * and reads them back for games / recap. Transport is the official
 * `@cloud99p/omnilearn-sdk` OmniLearnClient (vendored under ./omnilearn-sdk)
 * — recordBatch / search(metadataFilter) / delete(metadataFilter).
 *
 * Design goals (per meetplay-omnilearn-integration-prompt):
 *   1. Fire-and-forget: recording is best-effort and NEVER blocks or throws
 *      into the live (WS / game) hot path. Omnilearn being down must not
 *      degrade the meeting. Graceful degradation everywhere.
 *   2. Batched: final utterances are queued per room and flushed in one
 *      recordBatch every ~10s (max 100/req).
 *   3. Idempotent: a per-room dedup set (speakerId+text+ts) prevents duplicates
 *      from reconnects / repeated caption events.
 *   4. Scoped: every node carries `metadata.meetingId` (the MeetPlay room id)
 *      so reads filter by room and meeting cleanup can purge exactly that room.
 *
 * Env:
 *   OMNILEARN_URL      default http://localhost:8080
 *   OMNILEARN_API_KEY  optional; passed to the SDK (Bearer) when set
 *   OMNILEARN_ENABLED  default "1" — set "0" to disable recording entirely
 *   OMNILEARN_FLUSH_MS default 10000 — batch flush interval per room
 */

import { OmniLearnClient } from './omnilearn-sdk/index.js';

const OMNI_URL = (process.env.OMNILEARN_URL?.trim() || 'http://localhost:8080').replace(/\/$/, '');
const OMNI_KEY = process.env.OMNILEARN_API_KEY?.trim() || '';
const OMNI_ENABLED = process.env.OMNILEARN_ENABLED !== '0';
const BATCH_FLUSH_MS = Number(process.env.OMNILEARN_FLUSH_MS ?? 10_000);
const BATCH_MAX = 100;

interface PendingUtterance {
  speakerId: string;
  speakerName: string;
  text: string;
  ts: string;
}

function log(kind: 'info' | 'warn' | 'error', message: string, extra?: unknown): void {
  const label = `[omni:${kind.toUpperCase()}]`;
  if (kind === 'error') console.error(label, message, extra ?? '');
  else if (kind === 'warn') console.warn(label, message, extra ?? '');
  else console.log(label, message, extra ?? '');
}

// ── SDK client (module-level, one per process) ──────────────────────────

const sdk = new OmniLearnClient({
  apiKey: OMNI_KEY || 'meetplay-local',
  apiBaseUrl: OMNI_URL,
  serviceName: 'meetplay',
  serviceVersion: '0.1.0',
  domain: 'meetings',
  enableLogging: false,
  retryAttempts: 1, // fire-and-forget: a single retry is enough, don't stack backoffs in the hot path
  timeout: 6000,
});

// ── Per-room batcher ────────────────────────────────────────────────────

class RoomBatcher {
  private queue: PendingUtterance[] = [];
  private seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private roomId: string) {}

  enqueue(u: PendingUtterance): void {
    if (!OMNI_ENABLED) return;
    if (!u.text) return;
    const key = `${u.speakerId}|${u.text}|${u.ts}`;
    if (this.seen.has(key)) return; // idempotent — drop duplicate
    this.seen.add(key);
    this.queue.push(u);
    if (this.queue.length >= BATCH_MAX) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), BATCH_FLUSH_MS);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const records = this.queue.splice(0, BATCH_MAX);
    try {
      const result = await sdk.recordBatch({
        metadata: { meetingId: this.roomId, ts: new Date().toISOString() },
        records: records.map((r) => ({
          type: 'utterance',
          data: { text: r.text, speakerId: r.speakerId, speakerName: r.speakerName },
        })),
      });
      log('info', `batch ${this.roomId} recorded ${result.recorded ?? records.length}`);
    } catch (e) {
      log('error', `batch ${this.roomId} failed`, (e as Error).message);
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}

// ── Module-level room batchers ──────────────────────────────────────────

const batchers = new Map<string, RoomBatcher>();
function getBatcher(roomId: string): RoomBatcher {
  let b = batchers.get(roomId);
  if (!b) {
    b = new RoomBatcher(roomId);
    batchers.set(roomId, b);
  }
  return b;
}

// ── Public API ──────────────────────────────────────────────────────────

export const omniClient = {
  /** Best-effort queue of a final utterance for recording. Never throws. */
  recordUtterance(roomId: string, speakerId: string, speakerName: string, text: string): void {
    try {
      getBatcher(roomId).enqueue({
        speakerId,
        speakerName: speakerName || speakerId,
        text,
        ts: new Date().toISOString(),
      });
    } catch (e) {
      log('error', `recordUtterance(${roomId}) threw in enqueue`, (e as Error).message);
    }
  },

  /**
   * Flush this room's pending batch now. Returns the number of queued
   * utterances that were flushed on success, -1 on failure.
   * Used at meeting end to avoid data loss.
   */
  async flushRoom(roomId: string): Promise<number> {
    try {
      const b = batchers.get(roomId);
      if (!b) return 0;
      const before = b.pending;
      await b.flush();
      return before;
    } catch (e) {
      log('error', `flushRoom(${roomId}) failed`, (e as Error).message);
      return -1;
    }
  },

  /**
   * Purge all Omnilearn nodes for a meeting (privacy / room cleanup).
   * Fire-and-forget; returns deleted count or -1 on failure.
   */
  async deleteMeeting(roomId: string): Promise<number> {
    try {
      await this.flushRoom(roomId); // don't leave stragglers behind
      const result = await sdk.delete({ metadataFilter: { meetingId: roomId } });
      log('info', `deleteMeeting(${roomId}) deleted ${result.deleted ?? 0}`);
      return result.deleted ?? 0;
    } catch (e) {
      log('error', `deleteMeeting(${roomId}) failed`, (e as Error).message);
      return -1;
    }
  },

  /**
   * Fetch recorded utterances for a meeting, mapped to Who-Said-That quotes.
   * Returns [] when Omnilearn is unavailable (caller falls back to local).
   */
  async getQuotes(roomId: string, limit = 40): Promise<Array<{ text: string; speakerId: string; speakerName: string }>> {
    try {
      const response = await sdk.search({
        metadataFilter: { meetingId: roomId },
        types: ['utterance'],
        limit,
      });
      return (response.nodes || [])
        .map((n) => ({
          text: String(n?.data?.text ?? '').trim(),
          speakerId: String(n?.data?.speakerId ?? ''),
          speakerName: String(n?.data?.speakerName ?? ''),
        }))
        .filter((q) => q.text && q.speakerId);
    } catch (e) {
      log('error', `getQuotes(${roomId}) failed`, (e as Error).message);
      return [];
    }
  },

  /** Number of utterances still queued for a room (diagnostics). */
  pending(roomId: string): number {
    return batchers.get(roomId)?.pending ?? 0;
  },

  get enabled(): boolean {
    return OMNI_ENABLED;
  },

  get baseUrl(): string {
    return OMNI_URL;
  },
};
