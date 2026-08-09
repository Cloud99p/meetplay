import type { FastifyInstance } from 'fastify';
import { getRecap } from '../db/queries.js';
import { verifyRoomToken, generateRecapShareToken, verifyRecapShareToken } from '../utils/jwt.js';
import { omniClient } from '../intelligence/omniClient.js';

export async function recapRoutes(app: FastifyInstance) {
  // Full transcript + leaderboard + key quotes after a meeting ends. This is
  // the most sensitive data in the app — requires a valid room token so a
  // guessed room UUID alone is never enough to pull it (privacy hard
  // requirement; same pattern as /messages and /end).
  //
  // Two valid credentials, checked in order:
  //   1. `Authorization: Bearer <roomToken>` — a participant in the room.
  //   2. `?share=<token>` — a signed, expiring share link minted by the
  //      /recap/share endpoint below. Read-only: it can never be used for
  //      anything other than this one recap.
  app.get('/api/rooms/:id/recap', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const share = (req.query as { share?: string }).share;

    if (auth) {
      const payload = verifyRoomToken(auth);
      if (!payload) return reply.code(401).send({ error: 'Invalid room token' });
      if (payload.roomId !== id) return reply.code(403).send({ error: 'Token does not match room' });
    } else if (share) {
      const payload = verifyRecapShareToken(share);
      if (!payload) return reply.code(401).send({ error: 'Invalid share link' });
      if (payload.roomId !== id) return reply.code(403).send({ error: 'Share link does not match room' });
    } else {
      return reply.code(401).send({ error: 'Missing room token or share link' });
    }

    const [recap, graphQuotes] = await Promise.all([
      getRecap(id),
      omniClient.getQuotes(id, 50),
    ]);
    if (!recap) return reply.code(404).send({ error: 'Room not found' });
    return {
      ...recap,
      // Graph-augmented section: recorded utterances from the Omnilearn
      // knowledge graph for this meeting. Graceful — empty when Omnilearn is
      // unavailable so the recap page never breaks.
      graph: {
        available: omniClient.enabled,
        recordedUtterances: graphQuotes.length,
        quotes: graphQuotes.slice(0, 20).map((q) => ({
          text: q.text,
          speakerName: q.speakerName,
        })),
      },
    };
  });

  // Mint a signed, expiring share link for a recap. Requires the caller to
  // hold a valid room token (participant or host) — the same gate as reading
  // the recap — so only people who could already see it can share it.
  // The returned token is scoped to `recap_share` and expires in 7 days, so
  // a shared link is a controlled, revocable-by-expiry window instead of an
  // open door to the transcript forever.
  app.get('/api/rooms/:id/recap/share', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const payload = auth ? verifyRoomToken(auth) : null;
    if (!payload) return reply.code(401).send({ error: 'Invalid room token' });
    if (payload.roomId !== id) return reply.code(403).send({ error: 'Token does not match room' });

    const token = generateRecapShareToken(id);
    return {
      url: `/recap/${id}?share=${token}`,
      expiresIn: '7d',
    };
  });
}
