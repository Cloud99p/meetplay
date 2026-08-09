import jwt from 'jsonwebtoken';
import { loadConfig } from '../config.js';

export interface RoomTokenPayload {
  roomId: string;
  participantId: string;
  participantName: string;
  isHost: boolean;
}

/**
 * Single source of truth for the signing secret. loadConfig() already throws
 * on boot in production when JWT_SECRET is missing, so a real deployment can
 * never silently fall back to the public dev string.
 */
function getSecret(): string {
  return loadConfig().jwtSecret;
}

export function generateRoomToken(payload: RoomTokenPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: '24h' });
}

export function verifyRoomToken(token: string): RoomTokenPayload | null {
  try {
    return jwt.verify(token, getSecret()) as RoomTokenPayload;
  } catch {
    return null;
  }
}
