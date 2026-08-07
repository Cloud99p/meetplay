import type { FastifyInstance } from 'fastify';
import {
  createRoom,
  getRoomById,
  getParticipantById,
  getParticipantByRoomAndUser,
  addParticipant,
  getParticipantsByRoom,
  getChatMessages,
  updateRoom,
  setRoomHost,
} from '../db/queries.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { generateRoomToken, verifyRoomToken } from '../utils/jwt.js';
import { mintJoinToken } from '../livekit/token.js';
import { probeLiveKit } from './livekit.js';
import { loadConfig } from '../config.js';
import { endMeetingRoom } from '../endMeeting.js';
import { channelManager } from '../ws/channels.js';

const MAX_PARTICIPANTS = 50;
const cfg = loadConfig();

export async function roomsRoutes(app: FastifyInstance) {
  // Create a room
  app.post('/api/rooms', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; password?: string; userId?: string };
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    const password = typeof body.password === 'string' ? body.password : undefined;

    const passwordHash = password ? await hashPassword(password) : undefined;
    const room = await createRoom({ name, passwordHash });
    const livekitHealth = await probeLiveKit();

    // Host joins automatically at creation
    const host = await addParticipant({
      roomId: room.id,
      name: 'Host',
      isHost: true,
      userId: body.userId,
    });
    await setRoomHost(room.id, host.id);

    const token = generateRoomToken({
      roomId: room.id,
      participantId: host.id,
      participantName: host.name,
      isHost: true,
    });

    return reply.code(201).send({
      room: {
        id: room.id,
        name: room.name,
        hasPassword: Boolean(room.password_hash),
        state: room.state,
        transcriptionEnabled: room.transcription_enabled,
      },
      participant: {
        id: host.id,
        name: host.name,
        isHost: true,
      },
      token,
      livekitUrl: cfg.livekitUrl,
      livekitAvailable: livekitHealth.available,
    });
  });

  // Get room info (for join page)
  app.get('/api/rooms/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = await getRoomById(id);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    const participants = await getParticipantsByRoom(id);
    return {
      room: {
        id: room.id,
        name: room.name,
        hasPassword: Boolean(room.password_hash),
        state: room.state,
        transcriptionEnabled: room.transcription_enabled,
        participantCount: participants.length,
      },
    };
  });

  // Join a room
  app.post('/api/rooms/:id/join', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      name?: string;
      participantName?: string;
      password?: string;
      userId?: string;
    };

    const room = await getRoomById(id);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    if (room.state !== 'active') {
      return reply.code(403).send({ error: 'Room is locked or ended' });
    }

    const participants = await getParticipantsByRoom(id);
    if (participants.length >= MAX_PARTICIPANTS) {
      return reply.code(403).send({ error: 'Room at capacity' });
    }

    if (room.password_hash) {
      const password = body.password ?? '';
      const ok = await verifyPassword(password, room.password_hash);
      if (!ok) return reply.code(401).send({ error: 'Wrong password' });
    }

    let name =
      (typeof body.participantName === 'string' && body.participantName.trim()) ||
      (typeof body.name === 'string' && body.name.trim())
        ? ((body.participantName ?? body.name) as string).trim().slice(0, 40)
        : `Guest ${participants.length + 1}`;

    // Identity check: display names must be unique per room. A reconnecting
    // user (same userId) may rejoin under their existing name.
    const nameTaken = participants.find(
      (p) => p.name.toLowerCase() === name.toLowerCase() && !p.is_host
    );
    if (nameTaken && nameTaken.user_id !== (body.userId ?? null)) {
      return reply.code(409).send({ error: 'Name already taken in this room' });
    }

    // Refresh recovery: if this browser (same userId) already has a
    // participant row in this room — e.g. they hit refresh, which dropped
    // their connection but left the row — REUSE that row instead of creating
    // a duplicate "same name, different account". This also preserves their
    // original participant id so chat/game state stays tied to them.
    let participant;
    if (body.userId) {
      participant = await getParticipantByRoomAndUser(id, body.userId);
      if (participant) {
        // Keep the existing name (the user may have changed it on the form;
        // but their original identity is what other participants know them by)
        name = participant.name;
      }
    }
    if (!participant) {
      participant = await addParticipant({
        roomId: id,
        name,
        isHost: false,
        userId: body.userId,
      });
    }

    const token = generateRoomToken({
      roomId: id,
      participantId: participant.id,
      participantName: participant.name,
      // Preserve DB truth: a host reconnecting after a network blip keeps
      // host powers (recovery reuses their participant row).
      isHost: Boolean(participant.is_host),
    });

    const livekitHealth = await probeLiveKit();

    return reply.code(201).send({
      room: {
        id: room.id,
        name: room.name,
        hasPassword: Boolean(room.password_hash),
        state: room.state,
        transcriptionEnabled: room.transcription_enabled,
      },
      participant: {
        id: participant.id,
        name: participant.name,
        isHost: Boolean(participant.is_host),
      },
      token,
      livekitUrl: cfg.livekitUrl,
      livekitAvailable: livekitHealth.available,
    });
  });

  // Get room messages (for late joiners / reload)
  app.get('/api/rooms/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = await getRoomById(id);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    const messages = await getChatMessages(id);
    return { messages };
  });

  // Mint a LiveKit join token (requires room token)
  app.post('/api/rooms/:id/livekit-token', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

    const payload = auth ? verifyRoomToken(auth) : null;
    if (!payload) return reply.code(401).send({ error: 'Invalid room token' });
    if (payload.roomId !== id) return reply.code(403).send({ error: 'Token does not match room' });

    const participant = await getParticipantById(payload.participantId);
    if (!participant) return reply.code(404).send({ error: 'Participant not found' });

    const token = await mintJoinToken({
      roomName: id,
      identity: participant.livekit_identity ?? participant.id,
      participantName: participant.name,
    });
    return reply.send({ token });
  });

  // End meeting (host only)
  app.post('/api/rooms/:id/end', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const payload = auth ? verifyRoomToken(auth) : null;
    if (!payload) return reply.code(401).send({ error: 'Invalid room token' });
    if (payload.roomId !== id) return reply.code(403).send({ error: 'Token does not match room' });

    const participant = await getParticipantById(payload.participantId);
    if (!participant || !participant.is_host) {
      return reply.code(403).send({ error: 'Host only' });
    }

    await endMeetingRoom(id);
    return reply.send({ ok: true });
  });

  // Toggle transcription (host only)
  app.post('/api/rooms/:id/transcript/toggle', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { enabled?: boolean };
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const payload = auth ? verifyRoomToken(auth) : null;
    if (!payload) return reply.code(401).send({ error: 'Invalid room token' });
    if (payload.roomId !== id) return reply.code(403).send({ error: 'Token does not match room' });

    const participant = await getParticipantById(payload.participantId);
    if (!participant || !participant.is_host) {
      return reply.code(403).send({ error: 'Host only' });
    }

    const enabled = Boolean(body.enabled);
    await updateRoom(id, { transcription_enabled: enabled });
    // Broadcast to every connected client so their UI + STT state flips
    // immediately (client also optimistically updates, but this is the
    // authoritative sync for all participants).
    channelManager.broadcast(id, {
      type: 'transcript:toggled',
      payload: { enabled },
    });
    return reply.send({ enabled });
  });

  // Validate a room token (used by WS upgrade)
  app.post('/api/rooms/validate-token', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string };
    const payload = body.token ? verifyRoomToken(body.token) : null;
    if (!payload) return reply.code(401).send({ error: 'Invalid token' });
    return reply.send({ valid: true, payload });
  });
}
