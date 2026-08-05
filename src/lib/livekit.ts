import { Room, RoomEvent, type RemoteParticipant } from 'livekit-client';

export interface LiveKitConnection {
  room: Room;
  error?: string;
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
    // identity and name are embedded in the LiveKit JWT by the server
    await room.connect(livekitUrl, token);
    return { room };
  } catch (e: any) {
    const msg = e?.message ?? '';
    // Normalise common low-level errors into a human-friendly string
    if (
      msg.includes('Failed to fetch') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('server was not reachable')
    ) {
      return { room, error: 'The media server is not running or unreachable.' };
    }
    return {
      room,
      error: msg || 'Failed to connect to LiveKit',
    };
  }
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