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
  promoteToHost,
  listRoomsByOwner,
    isBannedFromRoom,
} from '../db/queries.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { isUuid } from '../utils/ids.js';
import { cleanRoomName } from '../utils/roomName.js';
import { generateRoomToken, verifyRoomToken } from '../utils/jwt.js';
import {
  checkPasswordAttempt,
  recordPasswordFailure,
  clearPasswordAttempts,
} from '../utils/passwordGuard.js';
import { mintJoinToken } from '../livekit/token.js';
import { probeLiveKit } from './livekit.js';
import { loadConfig } from '../config.js';
import { endMeetingRoom } from '../endMeeting.js';
import { channelManager } from '../ws/channels.js';
import { identify } from '../auth/clerk.js';

const MAX_PARTICIPANTS = 50;
const cfg = loadConfig();

export async function roomsRoutes(app: FastifyInstance) {
  /**
   * List the caller's own rooms, newest first.
   *
   * MUST be declared before `/api/rooms/:id` — Fastify matches in registration
   * order, and a literal segment would otherwise be captured by the `:id`
   * param route (which would then reject "rooms" as an invalid UUID).
   *
   * A guest (no valid token) gets an empty list, NOT a 401: the app treats
   * "not signed in" as a normal state everywhere else, and the client uses this
   * to decide whether to show a room history at all.
   */
  app.get('/api/rooms', async (req) => {
    const account = await identify(req.headers.authorization, req.log);
    if (!account.userId) return { rooms: [] };

    const limit = 20;
    const rows = await listRoomsByOwner(account.userId, limit);
    return {
      rooms: rows.map((r) => ({
        id: r.id,
        name: r.name,
        hasPassword: Boolean(r.password_hash),
        state: r.state,
        createdAt: r.created_at,
      })),
    };
  });

  // Create a room
  app.post('/api/rooms', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; password?: string; userId?: string };
    // Untrusted: strip markup and control chars, cap the length. See
    // utils/roomName.ts for why names are cleaned rather than escaped.
    const { value: name, altered: nameAltered } = cleanRoomName(body.name);
    if (nameAltered) {
      req.log.warn({ event: 'room.name_sanitized' }, 'room name was altered on create');
    }
    const password = typeof body.password === 'string' ? body.password : undefined;

    const passwordHash = password ? await hashPassword(password) : undefined;

    // Account link (optional). The Bearer token, when present and valid, is the
    // ONLY way `owner_user_id` gets set — `body.userId` is a guest hint and can
    // never claim ownership. `identify` never throws: an absent/expired/forged
    // token resolves to anonymous, so a guest still creates a room normally.
    const account = await identify(req.headers.authorization, req.log);

    const room = await createRoom({
      name,
      passwordHash,
      hostUserId: body.userId,
      ownerUserId: account.userId,
    });
    const livekitHealth = await probeLiveKit();

    // Host joins automatically at creation
    const host = await addParticipant({
      roomId: room.id,
      name: 'Host',
      isHost: true,
      userId: body.userId,
    });
    await setRoomHost(room.id, host.id, body.userId);

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
    // Reject a non-UUID before it reaches a query: Postgres answers 22P02,
    // which surfaced as a 500 on an unauthenticated endpoint.
    if (!isUuid(id)) return reply.code(400).send({ error: 'Invalid room id' });
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
    // Reject a non-UUID before it reaches a query: Postgres answers 22P02,
    // which surfaced as a 500 on an unauthenticated endpoint.
    if (!isUuid(id)) return reply.code(400).send({ error: 'Invalid room id' });
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
      // Server-side lockout per room+IP: the client-side form lockout is
      // cosmetic (refresh bypasses it). 5 failed tries -> 15 min 429.
      const ip = req.ip ?? 'unknown';
      const guard = checkPasswordAttempt(id, ip);
      if (!guard.allowed) {
        return reply.code(429).send({
          error: 'Too many failed password attempts. Try again later.',
          retryAfterMs: guard.retryAfterMs,
        });
      }
      const password = body.password ?? '';
      const ok = await verifyPassword(password, room.password_hash);
      if (!ok) {
        recordPasswordFailure(id, ip);
        return reply.code(401).send({ error: 'Wrong password' });
      }
      clearPasswordAttempts(id, ip);
    }

    // HOST KICK ENFORCEMENT.
    //
    // Deleting the participant row is not a kick on its own: this route
    // recreates it on the very next request, so a removed user simply reloads
    // and walks back in. The removal is durably recorded in room_bans, and it
    // is checked HERE — before any row is created — so reload and rejoin both
    // hit the same wall. 403 (not 404/409) so the client can tell "you were
    // removed" apart from "wrong password" or "room full".
    if (body.userId && (await isBannedFromRoom(id, body.userId))) {
      return reply.code(403).send({
        error: 'You were removed from this meeting by the host.',
        removed: true,
      });
    }

    // Participant display names are shown in chat, the people list and game
    // prompts, so they get the same markup stripping as room names.
    const rawName =
      (typeof body.participantName === 'string' && body.participantName.trim()) ||
      (typeof body.name === 'string' && body.name.trim())
        ? ((body.participantName ?? body.name) as string)
        : undefined;
    const cleanedName = cleanRoomName(rawName).value;

    let name =
      cleanedName !== undefined
        ? cleanedName.slice(0, 40)
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

    // OWNER RECOGNITION (host-rights bug).
    //
    // host_participant_id is a participant ROW id, so it can't survive the owner
    // coming back on a different row — and an interim host appointed while they
    // were away used to overwrite it entirely. host_user_id is the durable claim
    // (the browser's stable localStorage id), so recognise the owner by that and
    // re-assert host powers: promoteToHost demotes whoever holds the interim
    // flag, and setRoomHost points the room back at the owner's current row.
    // Runs after the row is resolved or created, so it covers both paths.
    if (body.userId) {
      const roomRow = await getRoomById(id);
      const isOwner =
        roomRow?.host_user_id === body.userId ||
        (!!roomRow?.host_participant_id && roomRow.host_participant_id === participant.id);
      if (isOwner && !participant.is_host) {
        try {
          participant = (await promoteToHost(participant.id)) ?? participant;
          await setRoomHost(id, participant.id, body.userId);
          console.log(
            `[rooms:${id}] owner rejoined — host powers restored to ${participant.id}`,
          );
        } catch (e) {
          console.error(`[rooms:${id}] owner host restore failed:`, e);
        }
      }
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

  // Get room messages (for late joiners / reload) — REQUIRES a valid room
  // token so the transcript/chat-adjacent data can't be pulled by anyone who
  // guesses a room UUID (privacy hard requirement).
  app.get('/api/rooms/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Reject a non-UUID before it reaches a query: Postgres answers 22P02,
    // which surfaced as a 500 on an unauthenticated endpoint.
    if (!isUuid(id)) return reply.code(400).send({ error: 'Invalid room id' });
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const payload = auth ? verifyRoomToken(auth) : null;
    if (!payload) return reply.code(401).send({ error: 'Invalid room token' });
    if (payload.roomId !== id) return reply.code(403).send({ error: 'Token does not match room' });

    const room = await getRoomById(id);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    const messages = await getChatMessages(id);
    return { messages };
  });

  // Mint a LiveKit join token (requires room token)
  app.post('/api/rooms/:id/livekit-token', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Reject a non-UUID before it reaches a query: Postgres answers 22P02,
    // which surfaced as a 500 on an unauthenticated endpoint.
    if (!isUuid(id)) return reply.code(400).send({ error: 'Invalid room id' });
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
    // Reject a non-UUID before it reaches a query: Postgres answers 22P02,
    // which surfaced as a 500 on an unauthenticated endpoint.
    if (!isUuid(id)) return reply.code(400).send({ error: 'Invalid room id' });
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const payload = auth ? verifyRoomToken(auth) : null;
    if (!payload) return reply.code(401).send({ error: 'Invalid room token' });
    if (payload.roomId !== id) return reply.code(403).send({ error: 'Token does not match room' });

    const participant = await getParticipantById(payload.participantId);
    if (!participant || participant.room_id !== id) {
      return reply.code(403).send({ error: 'Host only' });
    }
    // Authoritative host check: the is_host flag can drift (promotion races),
    // so also accept the room's recorded host pointer.
    const roomRow = await getRoomById(id);
    if (!participant.is_host && roomRow?.host_participant_id !== participant.id) {
      return reply.code(403).send({ error: 'Host only' });
    }

    await endMeetingRoom(id);
    return reply.send({ ok: true });
  });

  // Toggle transcription (host only)
  app.post('/api/rooms/:id/transcript/toggle', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Reject a non-UUID before it reaches a query: Postgres answers 22P02,
    // which surfaced as a 500 on an unauthenticated endpoint.
    if (!isUuid(id)) return reply.code(400).send({ error: 'Invalid room id' });
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
