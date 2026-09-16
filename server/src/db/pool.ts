import pg from 'pg';

/**
 * Single source of truth for the Postgres pool.
 *
 * Both the Fastify app (index.ts) and the query layer (pgQueries.ts) used to
 * build their own `new pg.Pool({ connectionString })` with no TLS settings.
 * That is fine for a local Postgres but breaks every managed provider:
 * Supabase, Railway, Neon, Render and RDS all require TLS, and Supabase's
 * pooler cert chain is not always in Node's trust store ("self-signed
 * certificate in certificate chain").
 *
 * SSL policy (env `DATABASE_SSL`):
 *   unset / 'require'  -> TLS with rejectUnauthorized:false  (default for
 *                         non-local hosts; encrypts but skips CA pinning)
 *   'verify'           -> TLS with full certificate verification
 *   'disable'          -> no TLS (local Postgres on localhost)
 *
 * Localhost hosts always default to no TLS so `docker run postgres` / a local
 * dev database keeps working with the same code path.
 */

export function sslConfigFor(connectionString: string | undefined): pg.PoolConfig['ssl'] {
  const mode = (process.env.DATABASE_SSL ?? '').trim().toLowerCase();
  if (mode === 'disable' || mode === 'off' || mode === 'false') return undefined;
  if (mode === 'verify') return { rejectUnauthorized: true };
  if (mode === 'require' || mode === 'no-verify') return { rejectUnauthorized: false };

  // Default: TLS everywhere except a local database.
  if (!connectionString) return undefined;
  let host = '';
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return { rejectUnauthorized: false };
  }
  const isLocal =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  return isLocal ? undefined : { rejectUnauthorized: false };
}

/** Build a pool for the configured DATABASE_URL. */
export function createPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  return new pg.Pool({
    connectionString,
    ssl: sslConfigFor(connectionString),
    // Keep the pool small: managed poolers (Supabase :6543, pgbouncer) cap
    // server-side connections per project, and a single-container app never
    // needs more than a handful.
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'meetplay',
  });
}
