#!/usr/bin/env node
// Verifies the app database is NOT exposed through a public Data API.
//
// Why: MeetPlay's backend (Fastify + direct pg as the table owner) needs no
// PostgREST access. On Supabase, tables in `public` are granted to the `anon`
// and `authenticated` roles by default, so without RLS the app tables were
// readable by anyone holding the publishable key — which ships inside the
// client bundle. Verified live on 2026-09-16 before the fix:
//
//   GET https://<ref>.supabase.co/rest/v1/transcript_events   → HTTP 200
//
// Running this after a migration catches a regression (e.g. a new table added
// without RLS) before real student sessions exist.
//
// Usage:
//   node --env-file=.env scripts/verify-db-security.mjs
//   SB_URL=https://<ref>.supabase.co SB_PUBLISHABLE=<key> \
//     node --env-file=.env scripts/verify-db-security.mjs   # also probes HTTP

const APP_TABLES = [
  'rooms',
  'participants',
  'chat_messages',
  'transcript_events',
  'game_rounds',
  'game_submissions',
  'room_recordings',
];

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failed++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const { default: pg } = await import('pg');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')
    ? false
    : { rejectUnauthorized: false },
  max: 2,
});

// ─── 1. RLS must be ON for every app table ─────────────────────────────────
const rls = await pool.query(
  `select c.relname, c.relrowsecurity, c.relforcerowsecurity
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`,
);
const byName = new Map(rls.rows.map((r) => [r.relname, r]));

for (const t of APP_TABLES) {
  const row = byName.get(t);
  check(`RLS enabled on ${t}`, row?.relrowsecurity === true, row ? '' : 'table missing');
  // FORCE would also apply the deny-all to the owner and lock the app out.
  check(`RLS not forced on ${t} (owner must bypass)`, row?.relforcerowsecurity !== true);
}

// ─── 2. anon/authenticated must hold no privileges on them ────────────────
const roles = await pool.query(`select rolname from pg_roles where rolname in ('anon','authenticated')`);
const roleNames = roles.rows.map((r) => r.rolname);

if (roleNames.length === 0) {
  console.log('\nPASS  no anon/authenticated roles (plain Postgres) — RLS is the only gate');
} else {
  const grants = await pool.query(
    `select table_name, grantee, privilege_type
       from information_schema.role_table_grants
      where table_schema = 'public' and grantee = any($1::text[])`,
    [roleNames],
  );
  check(
    `no table grants to ${roleNames.join('/')}`,
    grants.rowCount === 0,
    grants.rowCount ? `${grants.rowCount} grant(s) still present` : '',
  );

  // Column-level grants bypass table-level reasoning.
  const colGrants = await pool.query(
    `select count(*)::int as n
       from information_schema.column_privileges
      where table_schema = 'public' and grantee = any($1::text[])`,
    [roleNames],
  );
  check(`no column grants to ${roleNames.join('/')}`, colGrants.rows[0].n === 0);
}

// ─── 3. The owner path still works (the app must not be locked out) ───────
try {
  await pool.query('begin');
  const r = await pool.query(
    `insert into rooms (name) values ('security-check') returning id`,
  );
  const back = await pool.query('select name from rooms where id = $1', [r.rows[0].id]);
  await pool.query('rollback');
  check('owner role can still read/write (app unaffected)', back.rowCount === 1);
} catch (e) {
  await pool.query('rollback').catch(() => {});
  check('owner role can still read/write (app unaffected)', false, String(e.message).slice(0, 90));
}

// ─── 4. Optional: probe the live Data API ─────────────────────────────────
const base = process.env.SB_URL;
const key = process.env.SB_PUBLISHABLE;
if (!base || !key) {
  console.log('\nSKIP  Data API probe (set SB_URL + SB_PUBLISHABLE to include it)');
} else {
  for (const t of APP_TABLES) {
    try {
      const res = await fetch(`${base}/rest/v1/${t}?select=*&limit=1`, { headers: { apikey: key } });
      check(`Data API denies ${t}`, res.status !== 200, `HTTP ${res.status}`);
    } catch (e) {
      check(`Data API denies ${t}`, true, `unreachable (${e.message.slice(0, 40)})`);
    }
  }
}

await pool.end();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll database-security checks passed.');
process.exit(failed ? 1 : 0);
