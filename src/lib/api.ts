import type { Room } from '../types/meeting';
import type { ChatMessage } from '../types/chat';
import { getUserId } from './identity';

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
  transcript: Array<{ id: string; participantName: string; text: string; createdAt: string }>;
  gameRounds: Array<{
    id: string;
    gameType: string;
    roundData: unknown;
    startedAt: string;
    endedAt: string | null;
    submissions: Array<{
      participantName: string;
      submission: unknown;
      score: number;
    }>;
  }>;
}

export function getServerUrl(): string {
  return SERVER_URL;
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
    ...opts,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
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

export async function getChatHistory(roomId: string): Promise<{ messages: ChatMessage[] }> {
  return request<{ messages: ChatMessage[] }>(`/api/rooms/${roomId}/messages`);
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

export async function getRecap(roomId: string): Promise<RecapData> {
  return request<RecapData>(`/api/rooms/${roomId}/recap`);
}