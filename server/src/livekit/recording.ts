import {
  EgressClient,
  EgressStatus,
  EncodedFileType,
  EncodedFileOutput,
  EncodingOptionsPreset,
  S3Upload,
} from 'livekit-server-sdk';
import { loadConfig, type S3RecordingConfig } from '../config.js';
import { saveRoomRecording } from '../db/queries.js';

/**
 * Live call recording via LiveKit Egress (room composite).
 *
 * THE FIX (why this file was disabled before): egress has **no managed
 * storage** — `EncodedFileOutput` must carry a destination bucket in its
 * `output` oneof (`s3` | `gcp` | `azure` | `aliOSS`). Without one the API
 * rejects every request with `request has missing or invalid field: output`.
 * We now build a real `S3Upload` from S3_* env vars (Cloudflare R2, Backblaze
 * B2, MinIO and AWS S3 all speak this API), so recording works on any plan.
 *
 * Output shape (v2.17 SDK): pass the `EncodedFileOutput` BARE, not wrapped in
 * `EncodedOutputs` — the SDK then emits the legacy `output` oneof that Cloud
 * accepts, and the file output nests its own `s3` destination oneof.
 *
 * Every failure mode degrades to a clear `recording:error` message for the
 * host instead of a silent no-op: unconfigured LiveKit, disabled recording,
 * or a missing storage destination all report *why*.
 */

interface ActiveRecording {
  egressId: string;
  startedAt: number;
  /** Object key inside the bucket (needed to synthesize a download URL). */
  filepath: string;
  audioOnly: boolean;
  /** S3 destination snapshot — a redeploy mid-recording must not break stop. */
  s3: S3RecordingConfig;
}

export interface RecordingResult {
  downloadUrl: string | null;
  filename: string | null;
  durationSec: number;
  audioOnly: boolean;
}

export interface RecordingAvailability {
  available: boolean;
  /** Why recording can't start — shown verbatim to the host when unavailable. */
  reason?: string;
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

/**
 * Can this deployment record right now? Cheap, synchronous, and safe to call
 * per room-state snapshot — the host UI uses it to disable the record button
 * with a reason instead of letting the click fail.
 */
export function recordingAvailability(): RecordingAvailability {
  const cfg = loadConfig();
  if (!cfg.livekitUrl || !cfg.livekitApiKey || !cfg.livekitApiSecret) {
    return { available: false, reason: 'LiveKit is not configured on this server.' };
  }
  if (!cfg.recordingEnabled) {
    return { available: false, reason: 'Recording is disabled (RECORDING_ENABLED=0).' };
  }
  if (!cfg.recordingS3) {
    return {
      available: false,
      reason:
        'Recording needs a storage destination. Set S3_BUCKET, S3_ACCESS_KEY and ' +
        'S3_SECRET (plus S3_ENDPOINT for Cloudflare R2 / Backblaze B2 / MinIO).',
    };
  }
  return { available: true };
}

export function isRecording(roomName: string): boolean {
  return recordings.has(roomName);
}

/** Resolve the caller-supplied preset name, falling back to a sane default. */
function resolvePreset(name: string): EncodingOptionsPreset {
  const value = (EncodingOptionsPreset as unknown as Record<string, number>)[name];
  if (typeof value === 'number') return value as EncodingOptionsPreset;
  console.warn(`[lk] unknown RECORDING_PRESET '${name}' — using H264_1080P_30`);
  return EncodingOptionsPreset.H264_1080P_30;
}

/** Build the S3Upload destination message from env config. */
function buildS3Upload(s3: S3RecordingConfig): S3Upload {
  return new S3Upload({
    accessKey: s3.accessKey,
    secret: s3.secret,
    bucket: s3.bucket,
    region: s3.region,
    // Empty endpoint => AWS default (S3_REGION-derived) endpoint.
    endpoint: s3.endpoint,
    forcePathStyle: s3.forcePathStyle,
  });
}

/**
 * Egress usually returns a `downloadUrl` on LiveKit Cloud; on self-hosted /
 * R2 setups it returns only a `filepath`. When the bucket is public (R2
 * `pub-*.r2.dev`, a custom domain, or S3 public access) we can still hand the
 * host a directly playable link.
 */
function resolveDownloadUrl(
  filepath: string | undefined,
  downloadUrl: string | null | undefined,
  s3: S3RecordingConfig,
): string | null {
  if (downloadUrl) return downloadUrl;
  if (!filepath || !s3.publicBaseUrl) return null;
  const base = s3.publicBaseUrl.replace(/\/+$/, '');
  const key = filepath.replace(/^\/+/, '');
  return `${base}/${key}`;
}

export async function startRecording(
  roomName: string,
): Promise<{ ok: true; startedAt: number } | { ok: false; error: string }> {
  if (recordings.has(roomName)) {
    return { ok: false, error: 'A recording is already in progress.' };
  }
  const availability = recordingAvailability();
  if (!availability.available) {
    return { ok: false, error: availability.reason ?? 'Recording is unavailable.' };
  }
  const client = getEgressClient();
  const cfg = loadConfig();
  const s3 = cfg.recordingS3!;
  if (!client) {
    return { ok: false, error: 'LiveKit is not configured — recording is unavailable.' };
  }

  const audioOnly = cfg.recordingAudioOnly;
  // File extension MUST match the container or players refuse the file:
  // mp4 for the composite video, ogg (Opus) for audio-only.
  const ext = audioOnly ? 'ogg' : 'mp4';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filepath = `${s3.prefix}/${roomName}/${stamp}.${ext}`;

  try {
    const file = new EncodedFileOutput({
      fileType: audioOnly ? EncodedFileType.OGG : EncodedFileType.MP4,
      filepath,
      // The destination LiveKit Cloud / self-hosted egress uploads to. This
      // is the field whose absence caused "missing or invalid field: output".
      output: { case: 's3', value: buildS3Upload(s3) },
    });
    const info = await client.startRoomCompositeEgress(roomName, file, {
      // Presets are ignored for audio-only captures, so only pass one for video.
      ...(audioOnly ? {} : { encodingOptions: resolvePreset(cfg.recordingPreset) }),
      audioOnly,
    });
    recordings.set(roomName, {
      egressId: info.egressId,
      startedAt: Date.now(),
      filepath,
      audioOnly,
      s3,
    });
    return { ok: true, startedAt: Date.now() };
  } catch (e) {
    console.error(`[lk] startRecording(${roomName}) failed:`, (e as Error)?.message ?? e);
    return { ok: false, error: (e as Error)?.message ?? 'Failed to start recording.' };
  }
}

/**
 * Stop the active recording and wait for the finalized file result.
 * Returns null when no recording was running for this room.
 */
export async function stopRecording(roomName: string): Promise<RecordingResult | null> {
  const active = recordings.get(roomName);
  if (!active) return null;
  recordings.delete(roomName);

  const client = getEgressClient();
  const durationSec = Math.max(0, Math.round((Date.now() - active.startedAt) / 1000));
  if (!client) {
    return { downloadUrl: null, filename: active.filepath, durationSec, audioOnly: active.audioOnly };
  }

  try {
    await client.stopEgress(active.egressId);
  } catch (e) {
    // Egress may already have finished on its own — finalizing below still works.
    console.warn(`[lk] stopEgress(${active.egressId}) failed:`, (e as Error)?.message ?? e);
  }

  const file = await waitForFileResult(client, active.egressId);
  return {
    downloadUrl: resolveDownloadUrl(file?.filepath ?? active.filepath, file?.downloadUrl, active.s3),
    filename: file?.filepath ?? active.filepath,
    durationSec,
    audioOnly: active.audioOnly,
  };
}

/** Stop + finalize used when the meeting ends while a recording is live. */
export async function stopRecordingForRoomEnd(roomName: string): Promise<RecordingResult | null> {
  return stopRecordingAndSave(roomName);
}

/**
 * Stop the recording and persist the result for the recap page.
 *
 * This is THE entry point both stop paths use (host presses stop, or the
 * meeting ends) — persisting here means the recap can always play the file
 * back, even though egress finishes the upload after the room is gone.
 */
export async function stopRecordingAndSave(
  roomName: string,
  roomIdForStorage?: string,
): Promise<RecordingResult | null> {
  const result = await stopRecording(roomName);
  if (!result) return null;
  try {
    await saveRoomRecording({
      roomId: roomIdForStorage ?? roomName,
      downloadUrl: result.downloadUrl,
      filepath: result.filename,
      audioOnly: result.audioOnly,
      durationSec: result.durationSec,
    });
  } catch (e) {
    // A storage hiccup must not break the call teardown — the host still
    // gets the link in-memory this session.
    console.error(`[lk] failed to persist recording for ${roomName}:`, (e as Error)?.message ?? e);
  }
  return result;
}

/** Poll the egress until the file result appears (finalization takes a moment). */
async function waitForFileResult(
  client: EgressClient,
  egressId: string,
  attempts = 12,
): Promise<{ downloadUrl?: string; filepath?: string } | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const [info] = await client.listEgress({ egressId });
      const file = info?.fileResults?.[0] as { downloadUrl?: string; filepath?: string } | undefined;
      if (file && (file.downloadUrl || file.filepath)) {
        return { downloadUrl: file.downloadUrl, filepath: file.filepath };
      }
      // Egress failed outright (bad bucket creds, region mismatch, ...) —
      // surface it now instead of polling for a file that will never arrive.
      const status = info?.status;
      if (status === EgressStatus.EGRESS_FAILED) {
        console.error(
          `[lk] egress ${egressId} failed:`,
          info?.error ?? 'unknown error (check the S3 bucket/region/credentials)',
        );
        return null;
      }
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return null;
}
