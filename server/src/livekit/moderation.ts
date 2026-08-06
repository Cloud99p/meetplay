import {
  RoomServiceClient,
  TrackType,
  TrackSource,
} from 'livekit-server-sdk';
import { loadConfig } from '../config.js';

/**
 * Server-side LiveKit moderation (host powers) and room teardown.
 *
 * The WS signal layer (channels.ts) tells clients what happened, but real
 * enforcement lives here: muting a track through the LiveKit server API
 * actually stops the participant's audio/video — the client cannot ignore it.
 * Everything degrades gracefully: if LiveKit isn't configured/reachable the
 * helpers no-op (meeting keeps working in text mode).
 */

let cachedClient: RoomServiceClient | null = null;

function getRoomServiceClient(): RoomServiceClient | null {
  const cfg = loadConfig();
  if (!cfg.livekitApiKey || !cfg.livekitApiSecret || !cfg.livekitUrl) return null;
  if (!cachedClient) {
    cachedClient = new RoomServiceClient(
      cfg.livekitUrl,
      cfg.livekitApiKey,
      cfg.livekitApiSecret,
    );
  }
  return cachedClient;
}

/** Resolve the LiveKit identity used by a participant row. */
export function resolveLiveKitIdentity(participant: {
  livekit_identity: string | null;
  id: string;
}): string {
  return participant.livekit_identity ?? participant.id;
}

/**
 * Set a participant's audio (microphone) and/or video (camera) muted state
 * in the LiveKit room. Screen-share tracks are never touched.
 */
export async function setParticipantMediaMuted(
  roomName: string,
  identity: string,
  opts: { audio?: boolean; video?: boolean },
): Promise<void> {
  const client = getRoomServiceClient();
  if (!client) return;
  if (opts.audio === undefined && opts.video === undefined) return;

  let participants;
  try {
    participants = await client.listParticipants(roomName);
  } catch (e) {
    console.warn(`[lk] listParticipants(${roomName}) failed:`, (e as Error)?.message ?? e);
    return;
  }

  const target = participants.find((p) => p.identity === identity);
  if (!target) return; // not connected to media — nothing to enforce

  const mute = (muted: boolean) => (track: any) =>
    client
      .mutePublishedTrack(roomName, identity, track.sid, muted)
      .catch((e) =>
        console.warn(`[lk] mutePublishedTrack(${track.sid}, ${muted}) failed:`, (e as Error)?.message ?? e),
      );

  for (const track of target.tracks ?? []) {
    if (opts.audio !== undefined && track.type === TrackType.AUDIO) {
      await mute(opts.audio)(track);
    } else if (opts.video !== undefined && track.type === TrackType.VIDEO && track.source === TrackSource.CAMERA) {
      await mute(opts.video)(track);
    }
  }
}

/** Hard-kick a participant from the LiveKit room (host "remove" power). */
export async function removeParticipantFromLiveKit(
  roomName: string,
  identity: string,
): Promise<void> {
  const client = getRoomServiceClient();
  if (!client) return;
  try {
    await client.removeParticipant(roomName, identity);
  } catch (e) {
    console.warn(`[lk] removeParticipant(${identity}) failed:`, (e as Error)?.message ?? e);
  }
}

/**
 * Hard-delete the LiveKit room. Every participant connected to media is
 * disconnected immediately — this is what makes "end meeting" actually end
 * the call for everyone, even clients whose WS is down or missed the signal.
 */
export async function deleteLiveKitRoom(roomName: string): Promise<void> {
  const client = getRoomServiceClient();
  if (!client) return;
  try {
    await client.deleteRoom(roomName);
  } catch (e: any) {
    // NotFound (code 12) is expected when the room never had media — ignore.
    const code = e?.code ?? e?.details?.code;
    if (code !== 12 && code !== 5) {
      console.warn(`[lk] deleteRoom(${roomName}) failed:`, (e as Error)?.message ?? e);
    }
  }
}
