import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { verifyRoomToken } from '../utils/jwt.js';
import {
  getParticipantById,
  getParticipantsByRoom,
  getRoomById,
  updateRoom,
  removeParticipant,
  promoteToHost,
  saveChatMessage,
  saveTranscriptEvent,
  updateParticipantMuted,
  updateParticipantCamera,
} from '../db/queries.js';
import { channelManager } from './channels.js';
import { encode, decode, type ServerMessage } from './messages.js';
import { getGameEngine } from '../games/engine.js';
import { endMeetingRoom } from '../endMeeting.js';
import {
  resolveLiveKitIdentity,
  setParticipantMediaMuted,
  removeParticipantFromLiveKit,
} from '../livekit/moderation.js';
import { isRecording, startRecording, stopRecording } from '../livekit/recording.js';

// Track host disconnect timers: roomId -> { hostId, timer }
const hostTimers = new Map<string, { hostId: string; timer: NodeJS.Timeout }>();

// Track active connections per room: roomId -> Set<participantId>
const activeConnections = new Map<string, Set<string>>();

const HOST_PROMOTION_TIMEOUT_MS = 60_000;

function registerConnection(roomId: string, participantId: string) {
  let set = activeConnections.get(roomId);
  if (!set) {
    set = new Set();
    activeConnections.set(roomId, set);
  }
  set.add(participantId);
}

function unregisterConnection(roomId: string, participantId: string) {
  const set = activeConnections.get(roomId);
  if (!set) return;
  set.delete(participantId);
  if (set.size === 0) activeConnections.delete(roomId);
}

function isConnected(roomId: string, participantId: string): boolean {
  return activeConnections.get(roomId)?.has(participantId) ?? false;
}

async function sendRoomState(roomId: string, ws: WebSocket, participantId?: string) {
  try {
    const room = await getRoomById(roomId);
    if (!room) return;
    const participants = await getParticipantsByRoom(roomId);
    const engine = getGameEngine(roomId);
    const activeRound = await engine.getActiveRoundSnapshot();
    const leaderboard = await engine.buildLeaderboard();
    const market = engine.getMarketSnapshot();
    if (market && participantId) {
      const bet = engine.market?.bets.get(participantId);
      market.myBet = bet ? { guess: bet.guess, lockedOdds: bet.lockedOdds } : null;
    }
    const bingo = participantId ? engine.getBingoSnapshot(participantId) : null;
    const stats = engine.getStatsSnapshot();

    const msg: ServerMessage = {
      type: 'room:state',
      payload: {
        participants: participants.map((p: any) => ({
          id: p.id,
          name: p.name,
          isHost: p.is_host,
          isMuted: p.is_muted,
          isCameraOff: p.is_camera_off ?? false,
        })),
        transcriptionEnabled: room.transcription_enabled,
        roomState: room.state,
        recording: isRecording(roomId),
        activeRound,
        leaderboard,
        market,
        bingo,
        stats,
      },
    };
    ws.send(encode(msg));
  } catch (e) {
    console.error(`[ws:${roomId}] sendRoomState error:`, e);
  }
}

function scheduleHostPromotion(roomId: string, hostId: string) {
  // Cancel existing timer for this room
  const existing = hostTimers.get(roomId);
  if (existing) {
    clearTimeout(existing.timer);
    hostTimers.delete(roomId);
  }

  const timer = setTimeout(async () => {
    hostTimers.delete(roomId);
    // Only promote if host is still disconnected
    if (isConnected(roomId, hostId)) return;

    try {
      // Don't promote in a room that ended or was locked while the timer ran
      const room = await getRoomById(roomId);
      if (!room || room.state !== 'active') return;

      const participants = await getParticipantsByRoom(roomId);
      const candidate = participants.find((p: any) => p.id !== hostId);
      if (!candidate) return;

      await promoteToHost(candidate.id);
      channelManager.broadcast(roomId, {
        type: 'host:promoted',
        payload: { participantId: candidate.id },
      });
      console.log(`[ws:${roomId}] Host promoted to ${candidate.id}`);
    } catch (e) {
      console.error(`[ws:${roomId}] host promotion error:`, e);
    }
  }, HOST_PROMOTION_TIMEOUT_MS);

  hostTimers.set(roomId, { hostId, timer });
}

export async function wsHandler(socket: WebSocket, request: FastifyRequest) {
  const query = request.query as Record<string, string | undefined>;
  const roomId = query.roomId;
  const participantId = query.participantId;
  const token = query.token;

  if (!roomId || !participantId || !token) {
    socket.close(4000, 'Missing roomId, participantId or token');
    return;
  }

  const payload = verifyRoomToken(token);
  if (!payload || payload.roomId !== roomId || payload.participantId !== participantId) {
    socket.close(4001, 'Invalid token');
    return;
  }

  let participant: any;
  try {
    participant = await getParticipantById(participantId);
  } catch (e) {
    socket.close(4002, 'Database error');
    return;
  }
  if (!participant || participant.room_id !== roomId) {
    socket.close(4003, 'Participant not in room');
    return;
  }

  // If this participant is the host and there's a pending promotion timer, cancel it
  if (participant.is_host) {
    cancelHostPromotion(roomId, participantId);
  }

  // Join channel
  channelManager.join(roomId, participantId, participant.name, socket);
  registerConnection(roomId, participantId);

  // Start the always-on passive games (Word Count market + bingo) —
  // idempotent, so late joiners / reconnects are safe.
  const room = await getRoomById(roomId);
  await getGameEngine(roomId).startPassiveGames(room?.name ?? null);

  // Send current state snapshot (for reconnect resync / late joiners)
  await sendRoomState(roomId, socket, participantId);

  socket.on('message', async (raw) => {
    const data = raw.toString();
    const msg = decode(data);
    if (!msg) return;

    try {
      await handleMessage(roomId, participantId, participant, msg.type, msg.payload);
    } catch (e) {
      console.error(`[ws:${roomId}:${participantId}] handle error:`, e);
    }
  });

  socket.on('close', () => {
    channelManager.leave(roomId, participantId);
    unregisterConnection(roomId, participantId);

    // If host left, schedule promotion
    if (participant.is_host) {
      scheduleHostPromotion(roomId, participantId);
    }
  });
}

function cancelHostPromotion(roomId: string, participantId: string) {
  const existing = hostTimers.get(roomId);
  if (existing?.hostId === participantId) {
    clearTimeout(existing.timer);
    hostTimers.delete(roomId);
  }
}

function cancelHostTimersForRoom(roomId: string) {
  const existing = hostTimers.get(roomId);
  if (existing) {
    clearTimeout(existing.timer);
    hostTimers.delete(roomId);
  }
}

async function handleMessage(
  roomId: string,
  senderId: string,
  sender: any,
  type: string,
  payload: Record<string, unknown>
) {
  switch (type) {
    case 'chat:send': {
      const content = String(payload.content ?? '').trim().slice(0, 2000);
      if (!content) return;
      const msg = await saveChatMessage({
        roomId,
        participantId: senderId,
        content,
      });
      channelManager.broadcast(roomId, {
        type: 'chat:received',
        payload: {
          id: msg.id,
          participantId: senderId,
          participantName: sender.name,
          content,
          createdAt: msg.created_at,
        },
      });
      break;
    }

    case 'emoji:send': {
      const emoji = String(payload.emoji ?? '').slice(0, 8);
      if (!emoji) return;
      channelManager.broadcast(roomId, {
        type: 'emoji:received',
        payload: { participantId: senderId, participantName: sender.name, emoji },
      });
      break;
    }

    case 'hand:raise': {
      channelManager.broadcast(roomId, {
        type: 'hand:raised',
        payload: { participantId: senderId, participantName: sender.name },
      });
      break;
    }

    case 'hand:lower': {
      channelManager.broadcast(roomId, {
        type: 'hand:lowered',
        payload: { participantId: senderId },
      });
      break;
    }

    case 'caption:event': {
      const room = await getRoomById(roomId);
      if (!room?.transcription_enabled) return;

      const speakerId = String(payload.speakerId ?? senderId);
      const text = String(payload.text ?? '').trim();
      if (!text) return;
      const isFinal = Boolean(payload.isFinal);

      // Resolve speaker name
      let speakerName: string | null = sender.name;
      if (speakerId !== senderId) {
        const speaker = await getParticipantById(speakerId);
        speakerName = speaker?.name ?? null;
      }

      // Persist final utterances (synthetic mock IDs may fail FK — that's OK)
      if (isFinal) {
        try {
          await saveTranscriptEvent({ roomId, participantId: speakerId, text, isFinal });
        } catch {
          // speaker may be synthetic mock id — skip DB persistence
        }
      }

      // Broadcast caption to all
      channelManager.broadcast(roomId, {
        type: 'caption:event',
        payload: {
          speakerId,
          participantName: speakerName,
          text,
          isFinal,
          timestamp: Date.now(),
        },
      });

      // Forward to game engine
      const engine = getGameEngine(roomId);
      engine.addUtterance({ speakerId, text, timestamp: Date.now() });
      break;
    }

    case 'game:submit': {
      const roundId = String(payload.roundId ?? '');
      if (!roundId) return;
      const engine = getGameEngine(roomId);
      await engine.submitAnswer(roundId, senderId, sender.name, payload.answer);
      break;
    }

    case 'participant:mute': {
      const isHost = await checkIsHost(roomId, senderId);
      if (!isHost) return;
      const targetId = String(payload.targetId ?? '');
      if (!targetId || targetId === senderId) return;
      const muted = payload.muted !== false; // default: mute
      const target = await updateParticipantMuted(targetId, muted);
      // Enforce on the media server: the target's mic actually stops, even
      // if their client ignores the signal below.
      if (target) {
        await setParticipantMediaMuted(roomId, resolveLiveKitIdentity(target), {
          audio: muted,
        });
      }
      channelManager.broadcast(roomId, {
        type: 'participant:muted',
        payload: { targetId, isMuted: muted },
      });
      break;
    }

    case 'participant:camera': {
      const isHost = await checkIsHost(roomId, senderId);
      if (!isHost) return;
      const targetId = String(payload.targetId ?? '');
      if (!targetId || targetId === senderId) return;
      const cameraOff = payload.cameraOff !== false; // default: turn off
      const target = await updateParticipantCamera(targetId, cameraOff);
      // Enforce on the media server: the target's camera feed stops.
      if (target) {
        await setParticipantMediaMuted(roomId, resolveLiveKitIdentity(target), {
          video: cameraOff,
        });
      }
      channelManager.broadcast(roomId, {
        type: 'participant:camera',
        payload: { targetId, isCameraOff: cameraOff },
      });
      break;
    }

    case 'participant:remove': {
      const isHost = await checkIsHost(roomId, senderId);
      if (!isHost) return;
      const targetId = String(payload.targetId ?? '');
      if (!targetId || targetId === senderId) return;
      const target = await getParticipantById(targetId);
      await removeParticipant(targetId);
      if (target) {
        // Hard-kick from media too, not just the signal layer.
        await removeParticipantFromLiveKit(roomId, resolveLiveKitIdentity(target));
      }
      channelManager.removeFromRoom(roomId, targetId);
      channelManager.broadcast(roomId, {
        type: 'participant:removed',
        payload: { targetId },
      });
      break;
    }

    case 'room:lock': {
      const isHost = await checkIsHost(roomId, senderId);
      if (!isHost) return;
      await updateRoom(roomId, { state: 'locked' });
      channelManager.broadcast(roomId, {
        type: 'room:locked',
        payload: {},
      });
      break;
    }

    case 'room:end': {
      const isHost = await checkIsHost(roomId, senderId);
      if (!isHost) return;
      await endMeetingRoom(roomId);
      cancelHostTimersForRoom(roomId);
      break;
    }

    case 'recording:start': {
      const isHost = await checkIsHost(roomId, senderId);
      if (!isHost) return;
      const res = await startRecording(roomId);
      if (res.ok) {
        channelManager.broadcast(roomId, {
          type: 'recording:started',
          payload: { recording: true, startedAt: res.startedAt },
        });
      } else {
        channelManager.sendTo(roomId, senderId, {
          type: 'recording:error',
          payload: { message: res.error },
        });
      }
      break;
    }

    case 'recording:stop': {
      const isHost = await checkIsHost(roomId, senderId);
      if (!isHost) return;
      const res = await stopRecording(roomId);
      if (res.ok) {
        channelManager.broadcast(roomId, {
          type: 'recording:stopped',
          payload: {
            recording: false,
            downloadUrl: res.downloadUrl,
            filename: res.filename,
          },
        });
      } else {
        channelManager.sendTo(roomId, senderId, {
          type: 'recording:error',
          payload: { message: res.error },
        });
      }
      break;
    }

    default:
      break;
  }
}

async function checkIsHost(roomId: string, participantId: string): Promise<boolean> {
  const p = await getParticipantById(participantId);
  return Boolean(p?.is_host && p.room_id === roomId);
}