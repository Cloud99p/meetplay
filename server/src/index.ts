import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { roomsRoutes } from './routes/rooms.js';
import { recapRoutes } from './routes/recap.js';
import { livekitRoutes } from './routes/livekit.js';
import { sttRoutes } from './routes/stt.js';
import { wsHandler } from './ws/handler.js';
import { runMigrations } from './db/migrate.js';

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

// Rate limit all REST APIs (privacy/security NFR): 120 req/min per IP,
// slightly stricter on room creation/join to deter abuse.
await app.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX ?? 120),
  timeWindow: '1 minute',
});

app.get('/health', async () => ({ ok: true, service: 'meetplay-server' }));

// Apply schema migrations automatically at startup (idempotent, Postgres only).
// Retries briefly so a slowly-starting Docker/RAILWAY DB doesn't leave the
// schema un-migrated; the server still boots if the DB is unreachable.
if (!USE_MEMORY) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await runMigrations();
      app.log.info('[migrate] schema up to date');
      break;
    } catch (e) {
      app.log.warn(`[migrate] attempt ${attempt}/5 failed — retrying in 3s: ${(e as Error)?.message ?? e}`);
      if (attempt < 5) await new Promise((r) => setTimeout(r, 3000));
      else app.log.error('[migrate] giving up after 5 attempts — schema may be incomplete');
    }
  }
}

// WebSocket endpoint for realtime meeting events
app.get('/ws', { websocket: true }, wsHandler);

await app.register(roomsRoutes);
await app.register(recapRoutes);
await app.register(livekitRoutes);
await app.register(sttRoutes);

// ---- Static frontend (production) ----
// Serve the built Vite app from dist/ with SPA fallback. Skip if dist is
// missing (e.g. API-only mode or local dev via scripts/dev.mjs).
const staticDir = process.env.STATIC_DIR ?? path.resolve(process.cwd(), 'dist');
if (fs.existsSync(path.join(staticDir, 'index.html'))) {
  await app.register(fastifyStatic, {
    root: staticDir,
    prefix: '/',
    wildcard: false,
  });

  // SPA fallback: any non-API GET returns index.html (client-side routing)
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });
  app.log.info(`Serving static frontend from ${staticDir}`);
} else {
  app.log.warn(`No dist/index.html found at ${staticDir} — API-only mode`);
}

// In production (docker) Railway injects PORT; in dev scripts/dev.mjs runs the
// backend on 3001. The host binding stays 0.0.0.0 so the platform proxy can reach us.
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
