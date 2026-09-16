#!/usr/bin/env node
// Logical backup of the MeetPlay Postgres database (pg_dump → gzip).
//
// Why this exists: managed Postgres plans differ wildly on backups. Supabase's
// FREE tier has NO automated backups at all (daily backups + PITR start on the
// Pro plan), so "we use Supabase" is not by itself a backup strategy. This
// gives you a portable dump you own, runnable from a laptop or CI.
//
// Usage:
//   node scripts/db-backup.mjs                     # dump to ./backups/
//   node scripts/db-backup.mjs --out D:\backups    # custom directory
//   DATABASE_URL=postgres://... node scripts/db-backup.mjs
//
// pg_dump discovery: uses a local `pg_dump` if one is on PATH, otherwise falls
// back to `docker run --rm postgres:16 pg_dump` (no local install needed).
//
// Restore:
//   gunzip -c backups/meetplay-<stamp>.sql.gz | psql "$DATABASE_URL"
//   (or: docker run --rm -i postgres:16 psql "$DATABASE_URL" < dump.sql)
//
// Retention: keeps the newest KEEP dumps (default 14) and prunes older ones.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Load .env when present (same convention as scripts/dev.mjs).
try {
  if (fs.existsSync(path.resolve('.env'))) process.loadEnvFile(path.resolve('.env'));
} catch {
  /* optional */
}

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = path.resolve(outIdx >= 0 ? args[outIdx + 1] : 'backups');
const KEEP = Number(process.env.BACKUP_KEEP ?? 14);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (nothing to back up).');
  process.exit(1);
}
const safe = url.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@');
console.log(`Source: ${safe}`);

/** Run a command without a shell (avoids quoting/escaping issues). */
function run(cmd, argv, opts = {}) {
  try {
    return spawnSync(cmd, argv, { shell: false, ...opts });
  } catch (e) {
    return { status: null, error: e, stdout: '', stderr: String(e) };
  }
}

/** Prefer a local pg_dump; fall back to Docker. */
function resolvePgDump() {
  const local = run('pg_dump', ['--version'], { encoding: 'utf8' });
  if (local.status === 0) {
    return { cmd: 'pg_dump', baseArgs: [], label: local.stdout.trim() };
  }
  const docker = run('docker', ['run', '--rm', 'postgres:16', 'pg_dump', '--version'], {
    encoding: 'utf8',
  });
  if (docker.status === 0) {
    return {
      cmd: 'docker',
      baseArgs: ['run', '--rm', '-i', 'postgres:16', 'pg_dump'],
      label: `${docker.stdout.trim()} (via docker)`,
      viaDocker: true,
    };
  }
  return null;
}

const pgDump = resolvePgDump();
if (!pgDump) {
  console.error(
    'No pg_dump found.\n' +
      '  Install PostgreSQL client tools (adds pg_dump to PATH), or\n' +
      '  install Docker (the script then uses the postgres:16 image).',
  );
  process.exit(1);
}
console.log(`Using: ${pgDump.label}`);

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(outDir, `meetplay-${stamp}.sql.gz`);

const dump = run(
  pgDump.cmd,
  [
    ...pgDump.baseArgs,
    // Portable, restorable-anywhere dump: no owner/ACL assumptions (managed
    // providers don't let you recreate their roles).
    '--no-owner',
    '--no-privileges',
    '--clean',
    '--if-exists',
    // Inside a Docker fallback, `localhost` is the container itself — a local
    // dev database on the host is reached via host.docker.internal.
    pgDump.viaDocker
      ? url.replace(/@(localhost|127\.0\.0\.1)([:/])/, '@host.docker.internal$2')
      : url,
  ],
  { encoding: 'buffer', maxBuffer: 1024 * 1024 * 512 },
);

if (dump.status !== 0) {
  console.error(`pg_dump failed (exit ${dump.status}):`);
  console.error(dump.stderr?.toString().slice(0, 2000));
  process.exit(1);
}

const { gzipSync } = await import('node:zlib');
fs.writeFileSync(outFile, gzipSync(dump.stdout, { level: 9 }));
const sizeKb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`Wrote ${outFile} (${sizeKb} KB)`);

// Sanity check: a dump of an empty/failed run is a few hundred bytes.
if (fs.statSync(outFile).size < 512) {
  console.warn('WARNING: dump is suspiciously small — verify the database actually has tables.');
}

// Retention prune.
const files = fs
  .readdirSync(outDir)
  .filter((f) => /^meetplay-.*\.sql\.gz$/.test(f))
  .sort()
  .reverse();
for (const f of files.slice(KEEP)) {
  fs.unlinkSync(path.join(outDir, f));
  console.log(`Pruned old backup: ${f}`);
}
console.log(`Kept ${Math.min(files.length, KEEP)} backup(s) in ${outDir}`);
console.log('\nRestore with:');
console.log(`  gunzip -c "${outFile}" | psql "$DATABASE_URL"`);
