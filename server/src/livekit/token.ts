import { AccessToken } from 'livekit-server-sdk';
import { loadConfig, requireLiveKit } from '../config.js';

/**
 * Mint a LiveKit join token using credentials from the environment
 * (LIVEKIT_API_KEY / LIVEKIT_API_SECRET). No committed fallbacks.
 */
export async function mintJoinToken(opts: {
  roomName: string;
  identity: string;
  participantName: string;
}): Promise<string> {
  const { apiKey, apiSecret } = requireLiveKit(loadConfig());

  const at = new AccessToken(apiKey, apiSecret, {
    identity: opts.identity,
    name: opts.participantName,
  });
  at.addGrant({ roomJoin: true, room: opts.roomName });
  return await at.toJwt();
}
