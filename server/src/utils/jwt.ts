import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'meetplay-dev-secret';

export interface RoomTokenPayload {
  roomId: string;
  participantId: string;
  participantName: string;
  isHost: boolean;
}

export function generateRoomToken(payload: RoomTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

export function verifyRoomToken(token: string): RoomTokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as RoomTokenPayload;
  } catch {
    return null;
  }
}