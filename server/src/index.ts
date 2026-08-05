import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { roomsRoutes } from './routes/rooms.js';
import { recapRoutes } from './routes/recap.js';
import { wsHandler } from './ws/handler.js';

const app = Fastify({ logger: true });
const USE_MEMORY = !process.env.DATABASE_URL || process.env.USE_MEMORY_DB === '1';

if (!USE_MEMORY) {
  // Production / docker: connect to real Postgres
  const pg = await import('pg');
  const pool = new pg.default.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  app.decorate('pg', { pool });
}

await app.register(cors, { origin: true });
await app.register(websocket);

app.get('/health', async () => ({ ok: true, service: 'meetplay-server' }));

// WebSocket endpoint for realtime meeting events
app.get('/ws', { websocket: true }, wsHandler);

await app.register(roomsRoutes);
await app.register(recapRoutes);

const port = Number(process.env.PORT ?? 3001);
app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});

const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal}, shutting down`);
  if (!USE_MEMORY) {
    const pgPool = (app as any).pg?.pool;
    if (pgPool) await pgPool.end();
  }
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
