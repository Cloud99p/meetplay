import {
  Room,
  RoomEvent,
  VideoPresets,
  supportsAV1,
  supportsVP9,
  type RemoteParticipant,
  type RoomConnectOptions,
} from 'livekit-client';

export interface LiveKitConnection {
  room: Room;
  error?: string;
}

export interface LiveKitRetryOptions {
  /** Total connect attempts including the first (default 4). */
  maxAttempts?: number;
  /** Base backoff in ms between attempts (default 1500, doubles each time). */
  baseDelayMs?: number;
  /** Max delay cap in ms (default 10000). */
  maxDelayMs?: number;
  /** Called after each failed attempt (attempt index, delay before next). */
  onRetry?: (attempt: number, nextDelayMs: number, error: string) => void;
}

// LiveKit SDK's default connect timeout is 15s; we lower it so the UI
// recovers faster when the media server isn't reachable. Retries are handled
// explicitly by connectToLiveKitWithRetry below.
const CONNECT_TIMEOUT_MS = 8_000;

const CONNECT_OPTIONS: RoomConnectOptions = {
  maxRetries: 0,
  websocketTimeout: CONNECT_TIMEOUT_MS,
  peerConnectionTimeout: CONNECT_TIMEOUT_MS,
};

/**
 * Video quality profile.
 *
 * Previous setup: default codec (VP8) + 720p capture + stock bitrates —
 * noticeably soft/blurry, especially in low light or when tiles are large.
 *
 * New profile:
 *  - Capture at 1080p (top simulcast/SVC layer).
 *  - VP9 codec: roughly 50% better quality-per-bit than VP8 (SVC spatial
 *    layers, dynacast still pauses unneeded layers).
 *  - VP8 as backup codec so older browsers can still subscribe.
 *  - maintain-resolution: when bandwidth dips, keep detail and drop frames
 *    instead of smearing the picture (camera default is maintain-framerate).
 */
const VIDEO_CAPTURE_RESOLUTION = { width: 1920, height: 1080 };

/**
 * Audio capture constraints, forced explicitly.
 *
 * The SDK defaults to `voiceIsolation: true`; on Windows/Chrome that newer
 * constraint takes over from classic echo cancellation and has been reported
 * to leave a live acoustic loop (your own voice played back, escalating into
 * a feedback howl) — exactly the bug we saw. We force classic AEC + noise
 * suppression + auto-gain and turn voice isolation OFF so the browser always
 * runs the well-tested echo canceller.
 */
const AUDIO_CAPTURE_OPTIONS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceIsolation: false,
} as const;

/**
 * Pick the best codec this browser can actually publish:
 *  AV1 (best quality-per-bit, modern Chrome/Edge) -> VP9 (broad + SVC) -> VP8 (fallback).
 * Mirrors the SDK's own recommendation; supportsAV1/supportsVP9 already exclude
 * Safari/Firefox cases where SVC publishing is broken.
 */
function pickVideoCodec(): 'av1' | 'vp9' | 'vp8' {
  if (supportsAV1()) return 'av1';
  if (supportsVP9()) return 'vp9';
  return 'vp8';
}

function createRoom(): Room {
  return new Room({
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: { resolution: VIDEO_CAPTURE_RESOLUTION },
    audioCaptureDefaults: AUDIO_CAPTURE_OPTIONS,
    publishDefaults: {
      videoCodec: pickVideoCodec(),
      backupCodec: { codec: 'vp8' },
      // Lower layers used with the VP8 fallback (VP9/AV1 SVC derive their own
      // spatial layers, so this is ignored there). h720 top layer keeps video
      // crisp on large tiles instead of capping at 540p.
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
      // Default encoding when simulcast isn't negotiated (non-SVC codec path):
      // 1280x720@30fps @ 2.5 Mbps so the single-layer case is sharp too.
      videoEncoding: VideoPresets.h720.encoding,
      degradationPreference: 'maintain-resolution',
      // Screen share: default is 1080p @ 3 Mbps; bump to 4 Mbps so text and
      // slides stay crisp when presenting.
      screenShareEncoding: { maxBitrate: 4_000_000, maxFramerate: 30 },
    },
  });
}

const KNOWN_CONNECT_ERRORS: Array<{ pattern: string; friendly: string; retryable: boolean }> = [
  {
    pattern: 'Abort handler called',
    friendly: 'Connection to the media server timed out.',
    retryable: true,
  },
  {
    pattern: 'Failed to fetch',
    friendly: 'The media server is not running or unreachable.',
    retryable: true,
  },
  {
    pattern: 'ECONNREFUSED',
    friendly: 'The media server is not running or unreachable.',
    retryable: true,
  },
  {
    pattern: 'server was not reachable',
    friendly: 'The media server is not running or unreachable.',
    retryable: true,
  },
  {
    pattern: 'could not establish pc connection',
    friendly: 'Unable to establish a peer connection. Check your network and firewall.',
    retryable: true,
  },
  {
    pattern: 'network error',
    friendly: 'Network error while connecting to the media server.',
    retryable: true,
  },
  {
    pattern: 'Invalid token',
    friendly: 'The media server rejected the join token.',
    retryable: false,
  },
  {
    pattern: 'permission denied',
    friendly: 'The media server denied access to this room.',
    retryable: false,
  },
  {
    pattern: 'room not found',
    friendly: 'The meeting room does not exist on the media server.',
    retryable: false,
  },
  {
    pattern: 'not authorized',
    friendly: 'You are not authorized to join this room.',
    retryable: false,
  },
];

/**
 * Normalise a raw LiveKit SDK error into a human-friendly string.
 * Falls back to the original message if no known pattern matches.
 */
function normaliseError(msg: string): string {
  for (const { pattern, friendly } of KNOWN_CONNECT_ERRORS) {
    if (msg.includes(pattern)) return friendly;
  }
  return msg || 'Failed to connect to the media server';
}

/**
 * Whether an error is worth retrying. Network/timeout/unreachable errors are
 * transient — auth/permission errors are permanent and must surface immediately.
 */
function isRetryableError(msg: string): boolean {
  const hit = KNOWN_CONNECT_ERRORS.find(({ pattern }) => msg.includes(pattern));
  if (hit) return hit.retryable;
  // Unknown errors: default to retryable (transient network issues are the
  // common case; the attempt cap bounds the damage).
  return true;
}

/**
 * Resolve the LiveKit server URL that the browser can actually reach.
 *
 * Priority:
 *  1. `VITE_LIVEKIT_URL` env var (explicit client-side override, baked at build time).
 *  2. Server-provided URL — but only if it is NOT the default localhost fallback,
 *     because `ws://localhost:7880` refers to the user's own machine when running
 *     in a preview/proxy environment, not the sandbox where LiveKit actually lives.
 *  3. Derive from the page origin so the connection goes through the same host
 *     (Vite dev proxy / platform reverse proxy), matching how the API and WebSocket
 *     already work (see vite.config.ts `/rtc` proxy).
 */
function resolveLiveKitUrl(url?: string): string {
  const envUrl = import.meta.env.VITE_LIVEKIT_URL as string | undefined;
  if (envUrl) return envUrl;

  if (url && url !== 'ws://localhost:7880') return url;

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}

/**
 * Quick health probe to check whether LiveKit is reachable through the proxy
 * BEFORE attempting a WebSocket connection (which takes 8 s to time out).
 * Returns `true` if the server responded (any HTTP status), `false` if the
 * request itself failed (network error / unreachable).
 */
async function probeLiveKit(url: string): Promise<boolean> {
  try {
    const httpUrl = url
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:');
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), 2_000);
    const res = await fetch(`${httpUrl}/rtc/validate`, {
      method: 'GET',
      signal: ctrl.signal,
    });
    clearTimeout(id);
    // A response below 500 means LiveKit responded directly (even a 404
    // confirms it is reachable).  A 5xx (e.g. 502) means the Vite proxy
    // could not reach the upstream target, so LiveKit is not running.
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function connectToLiveKit(
  _roomName: string,
  _identity: string,
  _participantName: string,
  token: string,
  url?: string
): Promise<LiveKitConnection> {
  const livekitUrl = resolveLiveKitUrl(url);

  // Quick probe: if LiveKit isn't reachable through the proxy, fail fast
  // instead of waiting for the SDK's WebSocket timeout (8 s).
  const reachable = await probeLiveKit(livekitUrl);
  if (!reachable) {
    const room = createRoom();
    return {
      room,
      error: 'The media server is not running or unreachable.',
    };
  }

  const room = createRoom();

  try {
    // identity and name are embedded in the LiveKit JWT by the server.
    // Timeout/retry options are passed per-connect (RoomConnectOptions).
    await room.connect(livekitUrl, token, CONNECT_OPTIONS);

    // Publish local media right away (standard meeting behavior: you join
    // with mic + camera on). Toggling the ControlBar buttons later works
    // the same way. Failures (permission denied / no device) are non-fatal
    // — the user can still join and enable media manually.
    try {
      await room.localParticipant.setMicrophoneEnabled(true, AUDIO_CAPTURE_OPTIONS);
    } catch (e) {
      console.warn('[livekit] mic auto-enable failed:', (e as Error)?.message ?? e);
    }
    try {
      await room.localParticipant.setCameraEnabled(true);
    } catch (e) {
      console.warn('[livekit] camera auto-enable failed:', (e as Error)?.message ?? e);
    }

    // Unlock audio playback (browser autoplay policy). Called right after
    // connect, which happens from a user gesture (Join click), so it's
    // allowed; this guarantees remote audio actually plays.
    try {
      await room.startAudio();
    } catch (e) {
      console.warn('[livekit] startAudio:', (e as Error)?.message ?? e);
    }

    return { room };
  } catch (e: any) {
    const msg = e?.message ?? '';
    return {
      room,
      error: normaliseError(msg),
    };
  }
}

/**
 * Attempt to connect to LiveKit with retries and exponential backoff.
 *
 * Survives transient network blips: if the probe fails or the WebSocket
 * times out because the connection dipped, we back off and try again instead
 * of surfacing "audio and video unavailable" immediately.
 *
 * Permanent errors (invalid token, permissions, room not found) surface
 * immediately without retrying.
 */
export async function connectToLiveKitWithRetry(
  roomName: string,
  identity: string,
  participantName: string,
  token: string,
  url?: string,
  opts: LiveKitRetryOptions = {}
): Promise<LiveKitConnection> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1_500;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;

  let last: LiveKitConnection | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await connectToLiveKit(roomName, identity, participantName, token, url);
    if (!last.error) return last;

    // Permanent error — do not burn retries on auth failures.
    if (!isRetryableError(last.error)) return last;

    if (attempt < maxAttempts) {
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      opts.onRetry?.(attempt, delay, last.error);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // All attempts exhausted — return the last failure; the caller decides
  // whether to surface it (MeetingRoom banner) or keep retrying in the
  // background via reconnectLiveKit.
  return last ?? { room: new Room(), error: 'Failed to connect to the media server' };
}

/**
 * Background reconnect with capped retries — used after an unexpected
 * disconnect (network drop) to bring the room back without user action.
 *
 * Returns the reconnected room, or null once retries are exhausted.
 * `shouldStop` lets the caller abort (e.g. the user left the meeting).
 */
export async function reconnectLiveKit(
  roomName: string,
  identity: string,
  participantName: string,
  token: string,
  url: string,
  opts: LiveKitRetryOptions & { shouldStop?: () => boolean } = {}
): Promise<LiveKitConnection | null> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 2_000;
  const maxDelayMs = opts.maxDelayMs ?? 15_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.shouldStop?.()) return null;

    const result = await connectToLiveKit(roomName, identity, participantName, token, url);
    if (!result.error) return result;
    if (!isRetryableError(result.error)) return null;

    if (attempt < maxAttempts) {
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      opts.onRetry?.(attempt, delay, result.error);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}

export function disconnect(room: Room): void {
  room.disconnect();
}

export function onParticipantConnected(
  room: Room,
  handler: (participant: RemoteParticipant) => void
): () => void {
  room.on(RoomEvent.ParticipantConnected, handler);
  return () => room.off(RoomEvent.ParticipantConnected, handler);
}

export function onParticipantDisconnected(
  room: Room,
  handler: (participant: RemoteParticipant) => void
): () => void {
  room.on(RoomEvent.ParticipantDisconnected, handler);
  return () => room.off(RoomEvent.ParticipantDisconnected, handler);
}