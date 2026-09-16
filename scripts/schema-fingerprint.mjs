// Prints a normalized structural fingerprint of the public schema.
// Diff two databases to prove they match:
//
//   DATABASE_URL=postgres://... node scripts/schema-fingerprint.mjs > /tmp/a.txt
//   DATABASE_URL=postgres://... node scripts/schema-fingerprint.mjs > /tmp/b.txt
//   diff /tmp/a.txt /tmp/b.txt
//
// Read-only; prints no credentials.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(here, 'schema-fingerprint.sql'), 'utf8');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const useSsl = process.env.DATABASE_SSL
  ? process.env.DATABASE_SSL
  : /localhost|127\.0\.0\.1/.test(url)
    ? 'disable'
    : 'require';

const pool = new pg.Pool({
  connectionString: url,
  max: 1,
  ssl: useSsl === 'disable' ? false : { rejectUnauthorized: useSsl === 'verify' },
});

try {
  const { rows } = await pool.query(sql);
  for (const r of rows) console.log(r.line);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
