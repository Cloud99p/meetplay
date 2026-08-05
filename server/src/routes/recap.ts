import type { FastifyInstance } from 'fastify';
import { getRecap } from '../db/queries.js';

export async function recapRoutes(app: FastifyInstance) {
  app.get('/api/rooms/:id/recap', async (req, reply) => {
    const { id } = req.params as { id: string };
    const recap = await getRecap(id);
    if (!recap) return reply.code(404).send({ error: 'Room not found' });
    return recap;
  });
}
