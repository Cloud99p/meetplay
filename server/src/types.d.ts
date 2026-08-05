import type pg from 'pg';

declare module 'fastify' {
  interface FastifyInstance {
    pg: {
      pool: pg.Pool;
    };
  }
}
