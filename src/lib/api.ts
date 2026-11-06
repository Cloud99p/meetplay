import type { Room } from '../types/meeting';
import type { ChatMessage } from '../types/chat';
import { getUserId } from './identity';
import { getSessionToken } from './auth';

// Same-origin by default: the Vite dev proxy forwards /api and /ws to the
// backend (see vite.config.ts + scripts/dev.mjs), so the browser never needs
// to reach localhost directly. Set VITE_SERVER_URL to point at a deployed
// backend explicitly.
const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) ?? '';

export interface CreateRoomResult {
  room: {
    id: string;
    name: string | null;
    hasPassword: boolean;
    state: string;
    transcriptionEnabled: boolean;
  };
  participant: { id: string; name: string; isHost: boolean };
  token: string;
  livekitUrl: string;
  livekitAvailable?: boolean;
}

export interface JoinRoomResult {
  room: {
    id: string;
    name: string | null;
    hasPassword: boolean;
    state: string;
    transcriptionEnabled: boolean;
  };
  participant: { id: string; name: string; isHost: boolean };
  token: string;
  livekitUrl: string;
  livekitAvailable?: boolean;
}

export interface RecapData {
  room: {
    id: string;
    name: string | null;
    createdAt: string;
    endedAt: string | null;
    duration: number;
  };
  participants: Array<{ id: string; name: string; isHost: boolean; joinedAt: string }>;
  transcript: Array<{
    id: string;
    participantName: string;
    text: string;
    /**
     * NaijaVox override. Present only when Deepgram's English-flattened text
     * was replaced by the real Pidgin capture; `text` keeps what Deepgram
     * said so the recap can show both.
     */
    correctedText?: string;
    correctionReason?: string;
    createdAt: string;
  }>;
  gameRounds: Array<{
    id: string;
    gameType: string;
    roundData: unknown;
    startedAt: string;
    endedAt: string | null;
    submissions: Array<{
      participantId?: string;
      participantName: string;
      submission: unknown;
      score: number;
    }>;
  }>;
  leaderboard?: Array<{
    participantId: string;
    participantName: string;
    score: number;
    pointsPerRound: number;
    roundsPlayed: number;
  }>;
  keyQuotes?: Array<{
    quote: string;
    speakerName: string;
    correctGuesses: number;
    totalGuesses: number;
  }>;
  /** Call recordings (LiveKit Egress → S3). Empty when never recorded. */
  recordings?: Array<{
    id: string;
    /**
     * Playable link. On a private bucket the server mints a short-lived
     * signed URL here (see `urlExpiresIn`), so it works without public access
     * and stops working once the signature lapses.
     */
    downloadUrl: string | null;
    /** Object key in the bucket — shown when no playable URL is available. */
    filepath: string | null;
    audioOnly: boolean;
    durationSec: number;
    startedAt: string | null;
    createdAt: string;
    /** Seconds until `downloadUrl` expires (null when it's a public URL). */
    urlExpiresIn?: number | null;
  }>;
}

export function getServerUrl(): string {
  return SERVER_URL;
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  // Only advertise a JSON content-type when there's actually a body.
  // Fastify 5 rejects an empty body with `Content-Type: application/json`
  // as FST_ERR_CTP_EMPTY_JSON_BODY -> HTTP 400 before the route handler
  // runs. Body-less POSTs (e.g. endRoom) must send NO content-type.
  const hasBody = opts?.body != null;

  // Attach the Clerk session token when signed in. Fetched per request on
  // purpose: the tokens are short-lived, so a cached string would expire and
  // silently drop us to guest. `getSessionToken()` returns null (never throws)
  // when signed out or when accounts are unconfigured.
  const sessionToken = await getSessionToken();

  const res = await fetch(`${SERVER_URL}${path}`, {
    ...opts,
    // Merge caller headers UNDER the defaults so Content-Type is never
    // clobbered: previously `...opts` spread AFTER `headers`, so opts.headers
    // (e.g. { Authorization } on toggleTranscription) REPLACED the merged
    // object and dropped Content-Type — the server then saw req.body as a
    // raw JSON string instead of a parsed object, and Boolean(body.enabled)
    // silently became false. This broke turning transcription back ON.
    //
    // Account token goes UNDER the caller's headers too, so a room token
    // (room-scoped auth) always wins where a route sets one explicitly.
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      ...(opts?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    // 429 carries a server-authored message plus Retry-After. Surface the
    // wait as friendly copy rather than "Request failed (429)", because the
    // user's only sensible action is to wait a few seconds and retry.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0;
      throw new ApiError(
        wait > 0
          ? `Too many requests — try again in ${wait}s.`
          : 'Too many requests — try again in a moment.',
        429,
      );
    }
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // no body
    }
    throw new ApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const TOKEN_KEY = 'meetplay_room_token';

export function storeRoomToken(token: string) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function getRoomToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function clearRoomToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function createRoom(name?: string, password?: string): Promise<CreateRoomResult> {
  const result = await request<CreateRoomResult>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({
      name: name || undefined,
      password: password || undefined,
      userId: getUserId(),
    }),
  });
  storeRoomToken(result.token);
  return result;
}

export async function joinRoom(
  roomId: string,
  participantName: string,
  password?: string
): Promise<JoinRoomResult> {
  const result = await request<JoinRoomResult>(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: JSON.stringify({
      participantName,
      password: password || undefined,
      userId: getUserId(),
    }),
  });
  storeRoomToken(result.token);
  return result;
}

export async function getRoom(roomId: string): Promise<{ room: Room }> {
  return request<{ room: Room }>(`/api/rooms/${roomId}`);
}

/**
 * The signed-in user's own rooms, newest first.
 *
 * Auth rides on the shared `request` helper, which injects the Clerk session
 * Bearer token automatically — so no header here. The server returns an empty
 * list for a guest rather than an error, matching the app's contract that being
 * signed out is a normal state, not a failure.
 */
export interface MyRoom {
  id: string;
  name: string | null;
  hasPassword: boolean;
  state: string;
  createdAt: string;
}

export async function listMyRooms(): Promise<MyRoom[]> {
  const data = await request<{ rooms: MyRoom[] }>('/api/rooms');
  return data.rooms;
}

/** Identity as the SERVER sees it. `enabled:false` means accounts are off. */
export interface MeResponse {
  enabled: boolean;
  authenticated: boolean;
  user: {
    id: string;
    clerkUserId: string;
    name: string;
    email: string;
    imageUrl?: string;
  } | null;
}

/**
 * Read-only identity check.
 *
 * Uses GET on purpose: the server's GET handler never writes, so opening the
 * account page cannot create a `users` row as a side effect. Row creation
 * happens in `syncAccount()` below, called deliberately after sign-in.
 */
export async function getMe(): Promise<MeResponse> {
  return request<MeResponse>('/api/me');
}

/** Confirm a session and materialise the local user row. */
export async function syncAccount(): Promise<MeResponse> {
  return request<MeResponse>('/api/me', { method: 'POST', body: '{}' });
}

/**
 * Profile + progression for the signed-in caller.
 *
 * Read-only on the server (it never creates a user row), so opening the
 * profile page before the first authenticated write is safe. `rank` is
 * derived server-side from `points`, never stored, so the tier table can
 * change without a backfill.
 */
export interface ProfileResponse {
  enabled: boolean;
  authenticated: boolean;
  profile: {
    id: string;
    name: string | null;
    email: string | null;
    imageUrl: string | null;
    createdAt: string | null;
    rank: {
      points: number;
      tier: string;
      tierLabel: string;
      division: string | null;
      label: string;
      colour: string;
      emoji: string;
      pointsIntoTier: number;
      pointsForTier: number;
      toNextTier: number;
      /** 0..1 through the current tier. */
      progress: number;
      nextTier: string | null;
    };
    stats: {
      calls: number;
      wins: number;
      roundsPlayed: number;
      pointsEarned: number;
      bestCall: number;
    };
    history: Array<{
      id: string;
      /** null once the room has been cleaned up; the award is kept. */
      roomName: string | null;
      points: number;
      place: number;
      players: number;
      roundsPlayed: number;
      createdAt: string;
    }>;
  } | null;
}

export async function getProfile(): Promise<ProfileResponse> {
  return request<ProfileResponse>('/api/me/profile');
}

export async function getChatHistory(
  roomId: string,
  roomToken: string
): Promise<{ messages: ChatMessage[] }> {
  return request<{ messages: ChatMessage[] }>(`/api/rooms/${roomId}/messages`, {
    headers: { Authorization: `Bearer ${roomToken}` },
  });
}

export async function getLiveKitToken(
  roomId: string,
  participantId: string,
  participantName: string,
  roomToken: string
): Promise<{ token: string }> {
  return request<{ token: string }>(`/api/rooms/${roomId}/livekit-token`, {
    method: 'POST',
    body: JSON.stringify({ participantId, participantName }),
    headers: { Authorization: `Bearer ${roomToken}` },
  });
}

export async function endRoom(roomId: string, roomToken: string): Promise<void> {
  await request(`/api/rooms/${roomId}/end`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${roomToken}` },
  });
}

export async function toggleTranscription(
  roomId: string,
  enabled: boolean,
  roomToken: string
): Promise<{ enabled: boolean }> {
  return request<{ enabled: boolean }>(`/api/rooms/${roomId}/transcript/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
    headers: { Authorization: `Bearer ${roomToken}` },
  });
}

export async function getRecap(roomId: string, roomToken: string): Promise<RecapData> {
  return request<RecapData>(`/api/rooms/${roomId}/recap`, {
    headers: { Authorization: `Bearer ${roomToken}` },
  });
}

/** Fetch a recap via a signed, expiring share link (no room token needed). */
export async function getRecapByShare(roomId: string, shareToken: string): Promise<RecapData> {
  return request<RecapData>(`/api/rooms/${roomId}/recap?share=${encodeURIComponent(shareToken)}`);
}

/**
 * Mint a signed, expiring share link for a recap. Requires a valid room
 * token; the returned `url` is a relative path the caller should absolutize
 * against `window.location.origin`. Expires server-side after 7 days.
 */
export async function createRecapShareLink(
  roomId: string,
  roomToken: string
): Promise<{ url: string; expiresIn: string }> {
  return request<{ url: string; expiresIn: string }>(`/api/rooms/${roomId}/recap/share`, {
    headers: { Authorization: `Bearer ${roomToken}` },
  });
}