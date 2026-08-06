import {
  EgressClient,
  EncodedFileType,
  EncodedFileOutput,
} from 'livekit-server-sdk';
import { loadConfig } from '../config.js';

/**
 * Live call recording via LiveKit Egress (room composite MP4).
 *
 * The host starts/stops a recording; the server manages the egress job and
 * hands back the download URL once the file is finalized. On LiveKit Cloud
 * the file lands in their managed storage and `fileResults[0].downloadUrl`
 * is populated; with self-hosted + S3 you get a `filepath` instead (no
 * public URL) — the client falls back gracefully.
 *
 * Everything degrades to no-ops / clear errors when LiveKit isn't
 * configured or the plan doesn't allow egress.
 */

interface ActiveRecording {
  egressId: string;
  startedAt: number;
}

const recordings = new Map<string, ActiveRecording>();

let cachedEgress: EgressClient | null = null;

function getEgressClient(): EgressClient | null {
  const cfg = loadConfig();
  if (!cfg.livekitApiKey || !cfg.livekitApiSecret || !cfg.livekitUrl) return null;
  if (!cachedEgress) {
    cachedEgress = new EgressClient(cfg.livekitUrl, cfg.livekitApiKey, cfg.livekitApiSecret);
  }
  return cachedEgress;
}

export function isRecording(roomName: string): boolean {
  return recordings.has(roomName);
}

export async function startRecording(
  roomName: string,
): Promise<{ ok: true; startedAt: number } | { ok: false; error: string }> {
  if (recordings.has(roomName)) {
    return { ok: false, error: 'A recording is already in progress.' };
  }
  const client = getEgressClient();
  if (!client) {
    return { ok: false, error: 'LiveKit is not configured — recording is unavailable.' };
  }
  try {
    const output = new EncodedFileOutput({ fileType: EncodedFileType.MP4 });
    const info = await client.startRoomCompositeEgress(roomName, output, {});
    recordings.set(roomName, { egressId: info.egressId, startedAt: Date.now() });
    return { ok: true, startedAt: Date.now() };
  } catch (e) {
    console.error(`[lk] startRecording(${roomName}) failed:`, (e as Error)?.message ?? e);
    return { ok: false, error: (e as Error)?.message ?? 'Failed to start recording.' };
  }
}

export async function stopRecording(
  roomName: string,
): Promise<
  | { ok: true; downloadUrl: string | null; filename: string | null }
  | { ok: false; error: string }
> {
  const active = recordings.get(roomName);
  if (!active) return { ok: false, error: 'No active recording for this room.' };
  recordings.delete(roomName);

  const client = getEgressClient();
  if (!client) return { ok: true, downloadUrl: null, filename: null };

  try {
    await client.stopEgress(active.egressId);
  } catch (e) {
    // Egress may already have finished on its own — finalizing below still works.
    console.warn(`[lk] stopEgress(${active.egressId}) failed:`, (e as Error)?.message ?? e);
  }

  const file = await waitForFileResult(client, active.egressId);
  return {
    ok: true,
    downloadUrl: file?.downloadUrl ?? null,
    filename: file?.filename ?? null,
  };
}

/** Best-effort stop used when the meeting ends while a recording is live. */
export async function stopRecordingForRoomEnd(roomName: string): Promise<void> {
  const active = recordings.get(roomName);
  if (!active) return;
  recordings.delete(roomName);
  const client = getEgressClient();
  if (!client) return;
  try {
    await client.stopEgress(active.egressId);
  } catch {
    // ignore — room is going away anyway
  }
}

/** Poll the egress until the file result appears (finalization takes a moment). */
async function waitForFileResult(
  client: EgressClient,
  egressId: string,
  attempts = 12,
): Promise<{ downloadUrl?: string; filename?: string } | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const [info] = await client.listEgress({ egressId });
      const file = info?.fileResults?.[0] as any;
      if (file && (file.downloadUrl || file.filepath)) {
        return { downloadUrl: file.downloadUrl, filename: file.filepath };
      }
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return null;
}
