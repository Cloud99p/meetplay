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
import { isRecording, recordingAvailability, startRecording, stopRecordingAndSave } from '../livekit/recording.js';
import { presignRecordingUrl } from '../storage/presign.js';
import { omniClient } from '../intelligence/omniClient.js';

// Track host disconnect timers: roomId -> { hostId, timer }
const hostTimers = new Map<string, { hostId: string; timer: NodeJS.Timeout }>();

// Track active connections per room: roomId -> Set<participantId>
const activeConnections = new Map<string, Set<string>>();

// Grace period before an interim host is appointed while the owner is away.
// Env-configurable so tests don't have to wait a minute (and so a deployment can
// tune it without a code change). Explicit `0` is honoured — unlike
// `Number(v) || default`, which would silently fall back to 60s.
const HOST_PROMOTION_TIMEOUT_MS = (() => {
  const raw = process.env.HOST_PROMOTION_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 60_000;
})();

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

// ── Message rate limits ─────────────────────────────────────────────────────
// The hub is ONE process serving every room, so a single client spamming frames
// degrades everyone in the call. Two token buckets apply: per connection (protects
// the room) and per room (protects the process). Over-limit frames are dropped,
// the sender is told once, and sustained flooding closes the socket (1008) rather
// than letting it burn the event loop.
interface Bucket {
  tokens: number;
  updated: number;
  warned: boolean;
  strikes: number;
}

const connBuckets = new Map<string, Bucket>();
const roomBuckets = new Map<string, Bucket>();
const roomConnCounts = new Map<string, number>();

function makeBucket(burst: number): Bucket {
  return { tokens: burst, updated: Date.now(), warned: false, strikes: 0 };
}

function takeToken(bucket: Bucket, burst: number, perSec: number): boolean {
  const now = Date.now();
  bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.updated) / 1000) * perSec);
  bucket.updated = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function envNum(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Bursts stay generous: a real client sends a handful of frames per second
// (a caption, a chat line, a game tap), so these only catch floods.
const WS_MSG_BURST = envNum(process.env.WS_MSG_BURST, 40);
const WS_MSG_PER_SEC = envNum(process.env.WS_MSG_PER_SEC, 10);
const WS_ROOM_BURST = envNum(process.env.WS_ROOM_BURST, 200);
const WS_ROOM_PER_SEC = envNum(process.env.WS_ROOM_PER_SEC, 60);
// Dropped frames in a row before the connection is closed.
const WS_MSG_STRIKE_LIMIT = envNum(process.env.WS_MSG_STRIKE_LIMIT, 20);
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
    const recording = recordingAvailability();

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
        // Lets the host UI disable the record button with a reason instead of
        // letting the click fail with a server error.
        recordingAvailable: recording.available,
        recordingReason: recording.available ? null : recording.reason ?? null,
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

      await promoteToHost(candidate.id, { claimOwnership: false });
      channelManager.broadcast(roomId, {
        type: 'host:promoted',
        payload: { participantId: candidate.id },
      });
      console.log(
        `[ws:${roomId}] interim host: ${candidate.id} holds host powers while the owner ` +
          `(${hostId}) is away — ownership stays with the owner, who reclaims on rejoin`,
      );
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
  // A non-UUID id can only be a buggy client (the token below must match it),
  // and the Postgres path answers it with a 22P02 error instead of a clean
  // close. Reject it before any query runs.
  if (!isUuid(participantId) || !isUuid(roomId)) {
    socket.close(4000, 'Malformed roomId or participantId');
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
    // Announce current host powers to the room. The owner rejoining after an
    // interim promotion lands here (their powers were restored during the HTTP
    // join), and without this broadcast the interim host would keep showing
    // themselves as host and keep the host-only controls.
    channelManager.broadcast(roomId, {
      type: 'host:promoted',
      payload: { participantId },
    });
  }

  // Inbound listener FIRST. The socket is open as soon as we await anything
  // below, so a client that sends immediately after 'open' (a caption that
  // starts instantly, a chat message, a game action) used to hit a socket with
  // no 'message' listener attached — silently dropped, no error anywhere. Queue
  // until initialisation finishes, then replay in order.
  const pendingMessages: Array<{ type: string; payload: any }> = [];
  let ready = false;
  const dispatch = async (msg: { type: string; payload: any }) => {
    try {
      await handleMessage(roomId, participantId, participant, msg.type, msg.payload);
    } catch (e) {
      console.error(`[ws:${roomId}:${participantId}] handle error:`, e);
    }
  };

  socket.on('message', (raw) => {
    const msg = decode(raw.toString());
    if (!msg) return;

    // Metered BEFORE any work: a flood must not reach dispatch(), nor the pending
    // queue (which would otherwise grow without bound during setup).
    const connOk = takeToken(connBucket, WS_MSG_BURST, WS_MSG_PER_SEC);
    const roomOk = takeToken(roomBucket, WS_ROOM_BURST, WS_ROOM_PER_SEC);
    if (!connOk || !roomOk) {
      connBucket.strikes++;
      if (!connBucket.warned) {
        connBucket.warned = true;
        console.warn(
          `[ws:${roomId}:${participantId}] message rate limit hit (conn=${connOk ? "ok" : "over"}, room=${roomOk ? "ok" : "over"}) — dropping frames`,
        );
        try {
          socket.send(encode({ type: 'rate:limited', payload: { perSec: WS_MSG_PER_SEC, roomLimited: !roomOk } }));
        } catch {
          /* socket already gone */
        }
      }
      if (connBucket.strikes > WS_MSG_STRIKE_LIMIT) {
        console.warn(`[ws:${roomId}:${participantId}] closing: sustained message flooding`);
        try {
          socket.close(1008, 'message rate limit');
        } catch {
          /* ignore */
        }
      }
      return;
    }
    // Traffic inside the limit re-arms the warning, so one brief burst does not
    // leave the connection flagged for its lifetime.
    connBucket.strikes = 0;
    connBucket.warned = false;

    if (!ready) {
      pendingMessages.push(msg);
      return;
    }
    void dispatch(msg);
  });

  socket.on('close', () => {
    channelManager.leave(roomId, participantId);
    unregisterConnection(roomId, participantId);
    connBuckets.delete(participantId);
    const left = (roomConnCounts.get(roomId) ?? 1) - 1;
    if (left <= 0) {
      roomConnCounts.delete(roomId);
      roomBuckets.delete(roomId); // last one out drops the room bucket
    } else {
      roomConnCounts.set(roomId, left);
    }

    // If host left, schedule promotion
    if (participant.is_host) {
      scheduleHostPromotion(roomId, participantId);
    }
  });

  // Metering state for this connection and its room.
  const connBucket = makeBucket(WS_MSG_BURST);
  connBuckets.set(participantId, connBucket);
  const roomBucket = roomBuckets.get(roomId) ?? makeBucket(WS_ROOM_BURST);
  if (!roomBuckets.has(roomId)) roomBuckets.set(roomId, roomBucket);
  roomConnCounts.set(roomId, (roomConnCounts.get(roomId) ?? 0) + 1);
  // Join channel
  channelManager.join(roomId, participantId, participant.name, socket);
  registerConnection(roomId, participantId);

  // Start the always-on passive games (Word Count market + bingo) —
  // idempotent, so late joiners / reconnects are safe.
  const room = await getRoomById(roomId);
  await getGameEngine(roomId).startPassiveGames(room?.name ?? null);

  // Send current state snapshot (for reconnect resync / late joiners)
  await sendRoomState(roomId, socket, participantId);

  // Initialisation done — drain anything the client sent while we were setting up.
  ready = true;
  for (const msg of pendingMessages.splice(0)) {
    await dispatch(msg);
  }
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
        // Only synthetic ids reach this branch in practice ('speaker-0',
        // 'unknown', 'local'), and Postgres refuses a non-UUID with 22P02 —
        // which used to abort the whole caption handler (no broadcast, no
        // transcript row, no game feed) on EVERY utterance. Guard the lookup
        // instead of relying on the DB to be forgiving.
        const speaker = isUuid(rawSpeakerId) ? await getParticipantById(rawSpeakerId) : null;
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
      const target = isUuid(targetId) ? await getParticipantById(targetId) : null;
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
      // Finalize any live recording BEFORE tearing down the room, and hand the
      // host the download link: ending the meeting is the most common way a
      // recording stops, and after `endMeetingRoom` the client navigates away.
      const recapRecording = await stopRecordingAndSave(roomId);
      if (recapRecording) {
        channelManager.sendTo(roomId, senderId, {
          type: 'recording:stopped',
          payload: {
            recording: false,
            // Signed short-lived link (private bucket) — falls back to the
            // stored/public URL when signing isn't configured.
            downloadUrl:
              (await presignRecordingUrl(recapRecording.filename)) ?? recapRecording.downloadUrl,
            filename: recapRecording.filename,
          },
        });
      }
      await endMeetingRoom(roomId);
      cancelHostTimersForRoom(roomId);
      break;
    }

    case 'recording:start': {
      const isHost = await checkIsHost(roomId, senderId);
      if (!isHost) return;
      const started = await startRecording(roomId);
      if (!started.ok) {
        channelManager.sendTo(roomId, senderId, {
          type: 'recording:error',
          payload: { message: started.error },
        });
        break;
      }
      // Everyone sees the REC indicator, so nobody is recorded unknowingly.
      channelManager.broadcast(roomId, {
        type: 'recording:started',
        payload: { recording: true, startedAt: started.startedAt },
      });
      break;
    }

    case 'recording:stop': {
      const isHost = await checkIsHost(roomId, senderId);
      if (!isHost) return;
      const result = await stopRecordingAndSave(roomId);
      if (!result) break;
      // Broadcast the state change (no URL) to the room, then hand the host
      // the actual link — participants may watch it live but only the host
      // owns the artifact.
      channelManager.broadcast(roomId, {
        type: 'recording:stopped',
        payload: { recording: false, downloadUrl: null, filename: null },
      });
      channelManager.sendTo(roomId, senderId, {
        type: 'recording:stopped',
        payload: {
          recording: false,
          downloadUrl: (await presignRecordingUrl(result.filename)) ?? result.downloadUrl,
          filename: result.filename,
        },
      });
      break;
    }

    default:
      break;
  }
}

// One source of truth for "is this a UUID?": the same check guards route params
// (utils/ids.ts) and message payload ids here, so the two can't drift.
import { isUuid } from '../utils/ids.js';

async function checkIsHost(roomId: string, participantId: string): Promise<boolean> {
  if (!isUuid(participantId)) return false;
  const p = await getParticipantById(participantId);
  if (!p || p.room_id !== roomId) return false;
  if (p.is_host) return true;
  // Fall back to the room's recorded host pointer: the is_host flag can
  // drift (promotion races), but host_participant_id is the source of truth.
  const room = await getRoomById(roomId);
  return room?.host_participant_id === participantId;
}