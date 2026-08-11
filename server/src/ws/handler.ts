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

/**
 * Finals below this confidence are still broadcast as captions (UI dims
 * them) but are excluded from games, stats, the recap transcript and the
 * Omnilearn graph, so shaky turns don't pollute word counts.
 * Env: CAPTION_CONFIDENCE_FLOOR (default 0.5).
 */
const CONFIDENCE_FLOOR = Number(process.env.CAPTION_CONFIDENCE_FLOOR ?? 0.5);
import { encode, decode, type ServerMessage } from './messages.js';
import { getGameEngine } from '../games/engine.js';
import { endMeetingRoom } from '../endMeeting.js';
import {
  resolveLiveKitIdentity,
  setParticipantMediaMuted,
  removeParticipantFromLiveKit,
} from '../livekit/moderation.js';
import { isRecording } from '../livekit/recording.js';
import { omniClient } from '../intelligence/omniClient.js';

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
    const flash = participantId ? engine.getFlashSnapshot(participantId) : null;
    const userMarkets = engine.getUserMarketsSnapshot(participantId ?? '');
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
        flash,
        userMarkets,
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
      // Only promote a participant who is actually CONNECTED right now.
      // The old code picked the first non-host row regardless of connection
      // state, which could promote a stale/disconnected row and permanently
      // demote the real host (who is often just briefly disconnected during
      // a deploy/refresh). If no one connected is available, keep the host.
      const candidate = participants.find(
        (p: any) => p.id !== hostId && isConnected(roomId, p.id)
      );
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

      const rawSpeakerId = String(payload.speakerId ?? senderId);
      const text = String(payload.text ?? '').trim();
      if (!text) return;
      const isFinal = Boolean(payload.isFinal);
      const confidence = typeof payload.confidence === 'number' ? payload.confidence : undefined;
      // Low-confidence finals: still shown as captions (UI dims them), but
      // excluded from games/recap/DB so shaky turns don't pollute counts.
      const belowFloor = isFinal && typeof confidence === 'number' && confidence < CONFIDENCE_FLOOR;

      // Resolve the REAL speaker. Deepgram emits synthetic diarization ids
      // ('speaker-0', 'speaker-1', 'unknown'), and WebSpeech emits 'local'.
      // These don't match participant rows, so bingo cards (keyed by real
      // participant id) would never mark and stats/transcripts would be
      // attributed to a ghost speaker. Every client only transcribes its OWN
      // mic, so the sender IS the speaker — map synthetic ids back to the
      // sender's real participant id.
      let speakerId = rawSpeakerId;
      let speakerName: string | null = sender.name;
      if (rawSpeakerId !== senderId) {
        const speaker = await getParticipantById(rawSpeakerId);
        if (speaker) {
          speakerName = speaker.name ?? null;
        } else {
          // Synthetic id (speaker-N / unknown / local) → attribute to sender
          speakerId = senderId;
          speakerName = sender.name;
        }
      }

      console.log(
        `[caption] room=${roomId.slice(0, 8)} sender=${sender.name} rawSpeaker=${rawSpeakerId} -> speaker=${speakerId} final=${isFinal} conf=${confidence?.toFixed(2) ?? '-'}${belowFloor ? ` DROPPED (below ${CONFIDENCE_FLOOR})` : ''} text="${text.slice(0, 150)}"`,
      );

      // Persist final utterances (synthetic mock IDs may fail FK — that's OK)
      if (isFinal && !belowFloor) {
        try {
          await saveTranscriptEvent({ roomId, participantId: speakerId, text, isFinal });
        } catch {
          // speaker may be synthetic mock id — skip DB persistence
        }
        // Best-effort record into the Omnilearn knowledge graph (never throws).
        omniClient.recordUtterance(roomId, speakerId, speakerName ?? sender.name, text);
      }

      // Broadcast caption to all
      channelManager.broadcast(roomId, {
        type: 'caption:event',
        payload: {
          speakerId,
          participantName: speakerName,
          text,
          isFinal,
          confidence,
          timestamp: Date.now(),
        },
      });

      // Forward FINAL utterances to the game engine only. Deepgram interims
      // resend the FULL accumulated transcript each time, so feeding them to
      // the engine would double/triple-count every word during continuous
      // speech (Word Count Bet, Bingo marks, speaker stats, recap pool).
      // Interims still broadcast above for the live caption overlay.
      // Low-confidence finals (below the floor) are excluded too.
      if (isFinal && !belowFloor) {
        const engine = getGameEngine(roomId);
        engine.addUtterance({ speakerId, text, timestamp: Date.now() });
      }
      break;
    }

    case 'game:submit': {
      const roundId = String(payload.roundId ?? '');
      if (!roundId) return;
      const engine = getGameEngine(roomId);
      await engine.submitAnswer(roundId, senderId, sender.name, payload.answer);
      break;
    }

    case 'game:start': {
      // Player-chosen game. Any member can start; the engine rejects if a
      // round is already running or the conversation is too thin — the
      // reason goes back only to the requester.
      const gameType = (payload as { gameType: 'who_said_that' | 'scrabble' | 'bingo' }).gameType;
      const engine = getGameEngine(roomId);
      const result = await engine.startGame(gameType, senderId, sender.name);
      if (!result.ok) {
        channelManager.sendTo(roomId, senderId, {
          type: 'game:start:rejected',
          payload: { reason: result.reason ?? 'Cannot start that game right now.' },
        });
      }
      break;
    }

    case 'game:userMarket:create': {
      const engine = getGameEngine(roomId);
      const error = await engine.createUserMarket(
        senderId,
        sender.name,
        payload.word,
        payload.guess,
        payload.durationSec
      );
      if (error) {
        channelManager.sendTo(roomId, senderId, {
          type: 'game:userMarket:error',
          payload: { message: error },
        });
      }
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
      // Recording is DISABLED: LiveKit egress requires a cloud storage
      // destination (S3/GCP/Azure) which MeetPlay doesn't have, so egress
      // always fails with "request has missing or invalid field: output".
      // Short-circuit here instead of attempting the broken egress call.
      channelManager.sendTo(roomId, senderId, {
        type: 'recording:error',
        payload: { message: 'Recording is unavailable (no storage configured).' },
      });
      break;
    }

    case 'recording:stop': {
      // No-op: recording is disabled (see recording:start above).
      break;
    }

    default:
      break;
  }
}

async function checkIsHost(roomId: string, participantId: string): Promise<boolean> {
  const p = await getParticipantById(participantId);
  if (!p || p.room_id !== roomId) return false;
  if (p.is_host) return true;
  // Fall back to the room's recorded host pointer: the is_host flag can
  // drift (promotion races), but host_participant_id is the source of truth.
  const room = await getRoomById(roomId);
  return room?.host_participant_id === participantId;
}