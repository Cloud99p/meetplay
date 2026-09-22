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
import { pingDb } from './db/queries.js';
import { startRoomCleanup } from './cleanup.js';

const app = Fastify({ logger: true });

// Security headers on every response.
//
// No CSP yet, deliberately: the SPA talks to LiveKit over wss, plays media from
// blob: URLs and uses inline styles, so a strict policy has to be built and
// verified against a real session or it breaks the app in ways only the browser
// shows. The headers below are unconditional wins and cost nothing.
//
// Permissions-Policy keeps camera/mic/screen-share for ourselves (the product
// needs them) and switches off everything the app never asks for.
app.addHook('onSend', async (_req, reply) => {
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header(
    'Permissions-Policy',
    'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()',
  );
});
const USE_MEMORY = !process.env.DATABASE_URL || process.env.USE_MEMORY_DB === '1';

if (!USE_MEMORY) {
  // Production / docker: connect to real Postgres. Shared pool config (TLS
  // for managed providers, small pool for pooler-backed databases).
  const { createPool } = await import('./db/pool.js');
  const pool = createPool();
  app.decorate('pg', { pool });
}

// CORS: auth is Bearer-token (not cookies), so the practical risk of a
// permissive policy is lower — but reflecting ANY origin still lets a
// malicious page make authenticated-looking requests if a token ever leaks
// (XSS elsewhere, screenshots, etc.).
//   - CORS_ORIGINS set -> allow exactly those origins (comma-separated).
//   - otherwise in production -> deny all cross-origin (same-origin only;
//     the app is served from the same host).
//   - local dev -> still same-origin via the Vite proxy, so deny-all is safe
//     and correct there too.
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
await app.register(cors, {
  origin: corsOrigins.length > 0 ? corsOrigins : false,
});
await app.register(websocket);

// Rate limit all REST APIs (privacy/security NFR): 120 req/min per IP,
// slightly stricter on room creation/join to deter abuse.
await app.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX ?? 120),
  timeWindow: '1 minute',
});

// Health is only "healthy" if the database behind it is usable.
//
// An audit probe caught the old version answering {"ok":true} while every data
// route returned 500 because Postgres had rejected the credentials — a deploy that
// looks green in the dashboard and is broken for users. A 503 here makes the
// platform's healthcheck see what the users see.
app.get('/health', async (req, reply) => {
  const dbUp = await pingDb();
  if (!dbUp) {
    req.log.error('[health] database unreachable');
    return reply.code(503).send({ ok: false, service: 'meetplay-server', db: 'down' });
  }
  return { ok: true, service: 'meetplay-server', db: USE_MEMORY ? 'memory' : 'postgres' };
});

// Error handler: never leak internals to the caller.
//
// Found by an audit probe: a malformed room id reached Postgres and the raw driver
// error came straight back to the client —
//   {"statusCode":500,"code":"22P02","message":"invalid input syntax for type uuid: \"not-a-uuid\""}
// That is a 500 on an UNAUTHENTICATED endpoint, and it hands an attacker error
// codes and type names. Bad input is a client mistake, so it answers 400; anything
// unexpected answers a flat 500 while the detail stays in the server log.
app.setErrorHandler((err: unknown, req, reply) => {
  const e = err as { code?: string; statusCode?: number; message?: string };
  const status = e.statusCode ?? 500;

  if (e.code === '22P02') {
    // invalid input syntax (bad uuid / malformed value). See utils/ids.ts.
    req.log.warn({ err }, 'malformed input reached the database');
    return reply.code(400).send({ error: 'Malformed request' });
  }
  if (status >= 400 && status < 500) {
    return reply.code(status).send({ error: e.message ?? 'Request failed' });
  }
  req.log.error({ err }, 'unhandled error');
  return reply.code(500).send({ error: 'Internal Server Error' });
});

// Apply schema migrations automatically at startup (idempotent, Postgres only).
// Retries briefly so a slowly-starting Docker/RAILWAY DB doesn't leave the
// schema un-migrated; the server still boots if the DB is unreachable.
if (!USE_MEMORY) {
  let migrated = false;
  for (let attempt = 1; attempt <= 5 && !migrated; attempt++) {
    try {
      await runMigrations();
      app.log.info('[migrate] schema up to date');
      migrated = true;
    } catch (e) {
      app.log.warn(`[migrate] attempt ${attempt}/5 failed — retrying in 3s: ${(e as Error)?.message ?? e}`);
      if (attempt < 5) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  // A server without its schema answers 500 on every data route while looking
  // perfectly alive — and the platform keeps sending it traffic (verified by an
  // audit probe: /health said ok while Postgres was rejecting every query).
  // Refuse to start instead, so the previous good deploy stays up.
  // DB_STRICT_START=0 boots anyway, for debugging a broken database.
  if (!migrated) {
    const msg = '[migrate] schema unavailable after 5 attempts';
    if (process.env.DB_STRICT_START === '0') {
      app.log.error(`${msg} — DB_STRICT_START=0, starting anyway (degraded)`);
    } else {
      app.log.error(`${msg} — refusing to start with a broken database`);
      process.exit(1);
    }
  }
}

// WebSocket endpoint for realtime meeting events
app.get('/ws', { websocket: true }, wsHandler);

await app.register(roomsRoutes);
await app.register(recapRoutes);
await app.register(livekitRoutes);
await app.register(sttRoutes);

// Abandoned-room data retention: purge rooms idle > ROOM_RETENTION_HOURS
// (default 24h) so abandoned meetings don't keep transcripts in Postgres
// forever. Runs hourly by default; tunable via env.
startRoomCleanup();

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
