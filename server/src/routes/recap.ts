import type { FastifyInstance } from 'fastify';
import { getRecap } from '../db/queries.js';
import { omniClient } from '../intelligence/omniClient.js';

export async function recapRoutes(app: FastifyInstance) {
  app.get('/api/rooms/:id/recap', async (req, reply) => {
    const { id } = req.params as { id: string };
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
