import {
  EgressClient,
  EncodedFileType,
  EncodedFileOutput,
  EncodingOptionsPreset,
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
    // Pass the EncodedFileOutput DIRECTLY (not wrapped in EncodedOutputs) and
    // the encoding preset via RoomCompositeOptions.encodingOptions.
    //
    // v2.17 SDK gotchas (both previously broken here):
    //  1. Wrapping the file in `EncodedOutputs` ({ file }) makes the SDK send
    //     ONLY the modern `file_outputs` array and DROP the legacy `output`
    //     oneof. LiveKit Cloud requires the legacy oneof and rejects the
    //     request with "missing or invalid field: output". Passing the
    //     EncodedFileOutput bare makes the SDK send the legacy `output` oneof
    //     ({ case:'file', value }), which Cloud accepts.
    //  2. Passing the preset the wrong way made the SDK emit an invalid
    //     `advanced` options object. Passing it via RoomCompositeOptions.
    //     encodingOptions makes the SDK send `options: { case:'preset',
    //     value: 2 }`.
    const file = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      // The object key the recording is stored under in LiveKit Cloud's
      // managed storage.
      filepath: `meetplay/recordings/${roomName}-${Date.now()}.mp4`,
    });
    // Record at 1080p/30 (H.264, 4.5 Mbps) instead of the egress default 720p.
    const info = await client.startRoomCompositeEgress(roomName, file, {
      encodingOptions: EncodingOptionsPreset.H264_1080P_30,
    });
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
