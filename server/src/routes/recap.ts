import type { FastifyInstance } from 'fastify';
import { getRecap } from '../db/queries.js';
import { verifyRoomToken } from '../utils/jwt.js';
import { omniClient } from '../intelligence/omniClient.js';

export async function recapRoutes(app: FastifyInstance) {
  // Full transcript + leaderboard + key quotes after a meeting ends. This is
  // the most sensitive data in the app — requires a valid room token so a
  // guessed room UUID alone is never enough to pull it (privacy hard
  // requirement; same pattern as /messages and /end).
  app.get('/api/rooms/:id/recap', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const payload = auth ? verifyRoomToken(auth) : null;
    if (!payload) return reply.code(401).send({ error: 'Invalid room token' });
    if (payload.roomId !== id) return reply.code(403).send({ error: 'Token does not match room' });

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
}
