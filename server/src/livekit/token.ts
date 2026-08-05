import { AccessToken } from 'livekit-server-sdk';

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? 'devkey0123456789012345678901234567';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? 'devsecret0123456789012345678901234';

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
