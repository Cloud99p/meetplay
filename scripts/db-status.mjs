// Read-only health/status check for the configured Postgres database.
// Prints connection sanity, tables, row counts, RLS state, and the age of the
// oldest/newest rows. Writes NOTHING. Usage:
//   node --env-file=.env scripts/db-status.mjs

import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (use --env-file=.env)');
  process.exit(1);
}
const safe = url.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@');
const useSsl = process.env.DATABASE_SSL
  ? process.env.DATABASE_SSL
  : /localhost|127\.0\.0\.1/.test(url)
    ? 'disable'
    : 'require';

console.log(`Target: ${safe}`);
console.log(`TLS:    ${useSsl}\n`);

const pool = new pg.Pool({
  connectionString: url,
  max: 2,
  ssl: useSsl === 'disable' ? false : { rejectUnauthorized: useSsl === 'verify' },
});

try {
  const { rows: ver } = await pool.query(
    'select version() as v, current_database() as db, current_user as usr',
  );
  console.log(`Server: ${ver[0].v.split(' on ')[0]}`);
  console.log(`DB:     ${ver[0].db}   user: ${ver[0].usr}\n`);

  const { rows: tables } = await pool.query(`
    select c.relname                              as name,
           c.relrowsecurity                       as rls,
           c.relforcerowsecurity                  as force_rls,
           coalesce(s.n_live_tup, 0)              as approx_rows
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  `);

  console.log('public tables (RLS / approx rows):');
  for (const t of tables) {
    const { rows: [{ n }] } = await pool.query(
      `select count(*)::int as n from public."${t.name}"`,
    );
    console.log(
      `  - ${t.name.padEnd(20)} rls=${t.rls ? 'ON ' : 'off'} force=${t.force_rls ? 'ON ' : 'off'} rows=${n}`,
    );
  }

  const { rows: idx } = await pool.query(
    `select count(*)::int as n from pg_indexes where schemaname = 'public'`,
  );
  console.log(`\npublic indexes: ${idx[0].n}`);

  const { rows: grants } = await pool.query(`
    select grantee, count(*)::int as n
    from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon','authenticated','service_role')
    group by grantee order by grantee
  `);
  console.log('Data API role grants in public:');
  if (!grants.length) console.log('  (none — anon/authenticated have no table grants)');
  for (const g of grants) console.log(`  - ${g.grantee}: ${g.n}`);

  const { rows: rooms } = await pool.query(`
    select id, created_at, (select count(*)::int from participants p where p.room_id = r.id) as participants
    from rooms r order by created_at desc limit 5
  `);
  console.log('\nnewest rooms:');
  if (!rooms.length) console.log('  (no rooms yet)');
  for (const r of rooms) {
    console.log(`  - ${r.id}  created=${r.created_at.toISOString()}  participants=${r.participants}`);
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
