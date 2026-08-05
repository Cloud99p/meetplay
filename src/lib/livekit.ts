import { Room, RoomEvent, type RemoteParticipant, type RoomConnectOptions } from 'livekit-client';

export interface LiveKitConnection {
  room: Room;
  error?: string;
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

const KNOWN_CONNECT_ERRORS: Array<{ pattern: string; friendly: string }> = [
  {
    pattern: 'Abort handler called',
    friendly: 'Connection to the media server timed out. Check that LiveKit is running.',
  },
  {
    pattern: 'Failed to fetch',
    friendly: 'The media server is not running or unreachable.',
  },
  {
    pattern: 'ECONNREFUSED',
    friendly: 'The media server is not running or unreachable.',
  },
  {
    pattern: 'server was not reachable',
    friendly: 'The media server is not running or unreachable.',
  },
  {
    pattern: 'could not establish pc connection',
    friendly: 'Unable to establish a peer connection. Check your network and firewall.',
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

export async function connectToLiveKit(
  _roomName: string,
  _identity: string,
  _participantName: string,
  token: string,
  url?: string
): Promise<LiveKitConnection> {
  const livekitUrl = resolveLiveKitUrl(url);

  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: { resolution: { width: 1280, height: 720 } },
  });

  try {
    // identity and name are embedded in the LiveKit JWT by the server.
    // Timeout/retry options are passed per-connect (RoomConnectOptions).
    await room.connect(livekitUrl, token, CONNECT_OPTIONS);
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
 * Attempt to connect to LiveKit with a single retry — useful when the V1→V0
 * fallback race causes a false-negative on the first attempt.
 */
export async function connectToLiveKitWithRetry(
  roomName: string,
  identity: string,
  participantName: string,
  token: string,
  url?: string
): Promise<LiveKitConnection> {
  const first = await connectToLiveKit(roomName, identity, participantName, token, url);
  if (!first.error) return first;

  // Only retry on timeout/abort errors — not on permanent failures.
  const retryable =
    first.error.includes('timed out') ||
    first.error.includes('unreachable') ||
    first.error.includes('Connection to the media server');

  if (!retryable) return first;

  // Brief back-off so the proxy / server can stabilise
  await new Promise((r) => setTimeout(r, 1_500));

  const second = await connectToLiveKit(roomName, identity, participantName, token, url);
  // Return the (possibly still failing) result — the MeetingRoom banner handles it.
  return second;
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