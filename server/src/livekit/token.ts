import { AccessToken } from 'livekit-server-sdk';

// LiveKit Cloud instance (committed fallback so previews without .env work).
// ⚠️ ROTATE the API secret in the LiveKit dashboard after the buildathon.
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? 'APIHBwo5VwnwMag';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? 'Re9hGufUrm4TBOxwqGXcIegfe2KmgaYdEzQUWyc4LNLB';

export async function mintJoinToken(opts: {
  roomName: string;
  identity: string;
  participantName: string;
}): Promise<string> {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: opts.identity,
    name: opts.participantName,
  });
  at.addGrant({ roomJoin: true, room: opts.roomName });
  return await at.toJwt();
}
