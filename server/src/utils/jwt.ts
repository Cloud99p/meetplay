import jwt from 'jsonwebtoken';
import { loadConfig } from '../config.js';

export interface RoomTokenPayload {
  roomId: string;
  participantId: string;
  participantName: string;
  isHost: boolean;
}

export interface RecapSharePayload {
  roomId: string;
  /** Distinguishes share links from room tokens — a share link must never
   * grant participant powers, only read access to this one recap. */
  scope: 'recap_share';
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
    const payload = jwt.verify(token, getSecret()) as jwt.JwtPayload & RoomTokenPayload;
    // Recap share tokens are signed with the same secret but carry a
    // `recap_share` scope — they must NEVER be accepted where a room token is
    // required, or a shared recap link would double as room powers
    // (participant actions, ending the meeting, reading messages).
    if ((payload as { scope?: string }).scope === 'recap_share') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Generate a signed, expiring recap share link token. Read-only by design:
 * the scope field prevents it being mistaken for a room token anywhere, and
 * the short expiry means a leaked link stops working quickly.
 */
export function generateRecapShareToken(roomId: string): string {
  return jwt.sign({ roomId, scope: 'recap_share' }, getSecret(), { expiresIn: '7d' });
}

export function verifyRecapShareToken(token: string): RecapSharePayload | null {
  try {
    const payload = jwt.verify(token, getSecret()) as RecapSharePayload;
    if (payload.scope !== 'recap_share' || !payload.roomId) return null;
    return payload;
  } catch {
    return null;
  }
}
