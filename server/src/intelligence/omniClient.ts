/**
 * omniClient.ts — MeetPlay ⇄ Omnilearn integration client.
 *
 * Records meeting transcript utterances into the Omnilearn knowledge graph
 * (V1 API) and reads them back for games / recap.
 *
 * Design goals (per meetplay-omnilearn-integration-prompt):
 *   1. Fire-and-forget: recording is best-effort and NEVER blocks or throws
 *      into the live (WS / game) hot path. Omnilearn being down must not
 *      degrade the meeting. Graceful degradation everywhere.
 *   2. Batched: final utterances are queued per room and flushed in one
 *      POST /api/v1/knowledge/batch every ~10s (max 100/req).
 *   3. Idempotent: a per-room dedup set (speakerId+text+ts) prevents duplicates
 *      from reconnects / repeated caption events.
 *   4. Scoped: every node carries `metadata.meetingId` (the MeetPlay room id)
 *      so reads filter by room and meeting cleanup can purge exactly that room.
 *
 * Env:
 *   OMNILEARN_URL      default http://localhost:8080
 *   OMNILEARN_API_KEY  optional; sent as `x-api-key` when set
 *   OMNILEARN_ENABLED  default "1" — set "0" to disable recording entirely
 */

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

// ── Low-level HTTP (global fetch from Node 18+) ─────────────────────────

async function omniFetch(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (OMNI_KEY) headers['x-api-key'] = OMNI_KEY;
  const res = await fetch(`${OMNI_URL}${path}`, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body — ignore */
  }
  return { ok: res.ok, status: res.status, json };
}

function log(kind: 'info' | 'warn' | 'error', message: string, extra?: unknown): void {
  const label = `[omni:${kind.toUpperCase()}]`;
  if (kind === 'error') console.error(label, message, extra ?? '');
  else if (kind === 'warn') console.warn(label, message, extra ?? '');
  else console.log(label, message, extra ?? '');
}

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
      const { ok, status, json } = await omniFetch('/api/v1/knowledge/batch', {
        method: 'POST',
        body: JSON.stringify({
          records: records.map((r) => ({
            type: 'utterance',
            data: { text: r.text, speakerId: r.speakerId, speakerName: r.speakerName },
          })),
          metadata: { meetingId: this.roomId, ts: new Date().toISOString() },
        }),
      });
      if (!ok) {
        log('warn', `batch ${this.roomId} http ${status}`, json ?? '');
      } else {
        log('info', `batch ${this.roomId} recorded ${json?.recorded ?? records.length}`);
      }
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
   * Flush this room's pending batch now. Returns the number of recorded
   * nodes on success, -1 on failure. Used at meeting end to avoid data loss.
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
      const { ok, status, json } = await omniFetch('/api/v1/knowledge/delete', {
        method: 'POST',
        body: JSON.stringify({ metadataFilter: { meetingId: roomId } }),
      });
      if (!ok) {
        log('warn', `deleteMeeting(${roomId}) http ${status}`, json ?? '');
        return -1;
      }
      log('info', `deleteMeeting(${roomId}) deleted ${json?.deleted ?? 0}`);
      return json?.deleted ?? 0;
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
      const { ok, status, json } = await omniFetch('/api/v1/knowledge/search', {
        method: 'POST',
        body: JSON.stringify({ metadataFilter: { meetingId: roomId }, type: 'utterance', limit }),
      });
      if (!ok || !json?.results) {
        if (status >= 400) log('warn', `getQuotes(${roomId}) http ${status}`, json ?? '');
        return [];
      }
      return (json.results as any[])
        .map((r) => ({
          text: String(r?.data?.text ?? '').trim(),
          speakerId: String(r?.data?.speakerId ?? ''),
          speakerName: String(r?.data?.speakerName ?? ''),
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
