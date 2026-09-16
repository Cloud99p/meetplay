#!/usr/bin/env node
// Provisions the MeetPlay production database on Supabase, then PROVES it
// works by running the migrations + verification suite against it.
//
// Recommended setup is a DEDICATED Supabase project (own credentials,
// connection budget and backup timeline) — not a second database inside an
// existing project, and not a schema prefix. See docs/POSTGRES.md.
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/supabase-provision.mjs \
//     [--name meetplay-prod] [--region eu-central-1] [--org <org-id>] \
//     [--password <db-password>] [--dry-run]
//
//   --dry-run   list organizations/projects and print the plan, create nothing.
//
// The script:
//   1. lists organizations (pick one with --org if you have several)
//   2. creates the project (or reuses one with the same name)
//   3. waits for ACTIVE_HEALTHY
//   4. resolves the SESSION POOLER connection string (TCP, not the
//      transaction pooler on :6543 — pg_dump needs session-level statements)
//   5. runs the real migrations against it and the verification suite
//   6. prints the exact env vars to set on Railway
//
// The access token is a Supabase Management API token (sbp_...), created at
// https://supabase.com/dashboard/account/tokens — it is NOT the anon/service
// key and is never written to disk by this script.

import process from 'node:process';

const API = 'https://api.supabase.com';
const token = process.env.SUPABASE_ACCESS_TOKEN;

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

if (!token) {
  console.error(
    'SUPABASE_ACCESS_TOKEN is not set.\n' +
      'Create a Management API token at https://supabase.com/dashboard/account/tokens\n' +
      '  PowerShell: $env:SUPABASE_ACCESS_TOKEN="sbp_..."',
  );
  process.exit(1);
}

const name = arg('name', 'meetplay-prod');
const region = arg('region', 'eu-central-1');
const orgArg = arg('org');
const password = arg('password');
const dryRun = hasFlag('dry-run');

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → HTTP ${res.status}: ${
        typeof json === 'string' ? json : JSON.stringify(json)
      }`,
    );
  }
  return json;
}

// ─── 1. Organizations ───────────────────────────────────────────────────────
let orgs;
try {
  orgs = await api('GET', '/v1/organizations');
} catch (e) {
  const msg = String(e?.message ?? e);
  if (/HTTP 401|HTTP 403/.test(msg)) {
    console.error('Supabase rejected the access token (401/403).');
    console.error('Create a Management API token at https://supabase.com/dashboard/account/tokens');
    console.error('It must start with sbp_ and belong to the account that owns the project.');
  } else {
    console.error(`Could not reach the Supabase Management API: ${msg}`);
  }
  process.exit(1);
}
console.log(`Organizations (${orgs.length}):`);
for (const o of orgs) console.log(`  - ${o.name}  id=${o.id}`);
if (orgs.length === 0) {
  console.error('No organizations on this account — create one in the dashboard first.');
  process.exit(1);
}
const org = orgArg ? orgs.find((o) => o.id === orgArg) : orgs[0];
if (!org) {
  console.error(`Organization ${orgArg} not found.`);
  process.exit(1);
}
console.log(`\nUsing organization: ${org.name} (${org.id})`);

// ─── 2. Existing projects (reuse instead of creating duplicates) ────────────
const projects = await api('GET', '/v1/projects');
const existing = projects.find((p) => p.name === name);
console.log(`Regions available: (default requested: ${region})`);

if (dryRun) {
  console.log(`\n[dry-run] Would ${existing ? 'REUSE' : 'CREATE'} project "${name}" in ${region}.`);
  if (existing) console.log(`  Existing ref: ${existing.id} status=${existing.status}`);
  console.log('Nothing was created.');
  process.exit(0);
}

let projectRef;
let dbPassword = password;

if (existing) {
  console.log(`\nProject "${name}" already exists (ref ${existing.id}) — reusing it.`);
  projectRef = existing.id;
  if (!dbPassword) {
    console.error(
      'Pass --password <db-password> so the connection string can be built\n' +
        '(Supabase never returns an existing database password).',
    );
    process.exit(1);
  }
} else {
  if (!dbPassword) {
    // Generate a strong password — Supabase requires 8+ chars with mixed case,
    // digits and symbols.
    const { randomBytes } = await import('node:crypto');
    dbPassword = `${randomBytes(18).toString('base64url')}Aa1!`;
    console.log('\nGenerated a database password. SAVE THIS — it is not shown again:');
    console.log(`  DB PASSWORD: ${dbPassword}`);
  }
  console.log(`\nCreating project "${name}" in ${region} (free plan)...`);
  const created = await api('POST', '/v1/projects', {
    organization_id: org.id,
    name,
    db_pass: dbPassword,
    region,
    plan: 'free',
  });
  projectRef = created.id ?? created.ref;
  console.log(`Created ref=${projectRef} — waiting for provisioning (this takes a few minutes)...`);
}

// ─── 3. Wait for ACTIVE_HEALTHY ─────────────────────────────────────────────
const deadline = Date.now() + 15 * 60 * 1000;
let status = 'UNKNOWN';
while (Date.now() < deadline) {
  try {
    const s = await api('GET', `/v1/projects/${projectRef}`);
    status = s.status ?? 'UNKNOWN';
  } catch (e) {
    status = `(status check failed: ${e.message})`;
  }
  console.log(`  status: ${status}`);
  if (status === 'ACTIVE_HEALTHY') break;
  if (['INIT_FAILED', 'REMOVED', 'PAUSED'].includes(status)) {
    console.error(`Project entered ${status} — stopping.`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 15_000));
}
if (status !== 'ACTIVE_HEALTHY') {
  console.error('Timed out waiting for the project to become healthy.');
  process.exit(1);
}

// ─── 4. Connection string (SESSION POOLER) ─────────────────────────────────
// The transaction pooler (:6543) is deliberately avoided: migrations and
// pg_dump need session-level statements. Direct db.<ref>.supabase.co is
// IPv6-only on the free tier, so the session pooler is the portable choice.
let poolerHost;
try {
  const pooler = await api('GET', `/v1/projects/${projectRef}/config/database/pooler`);
  poolerHost = pooler?.[0]?.connection_string
    ? new URL(pooler[0].connection_string).host
    : pooler?.[0]?.db_host ?? pooler?.db_host;
} catch (e) {
  console.warn(`Could not read pooler config (${e.message}) — falling back to the standard host.`);
}
poolerHost ??= `aws-0-${region}.pooler.supabase.com`;

const encPassword = encodeURIComponent(dbPassword);
const url = `postgresql://postgres.${projectRef}:${encPassword}@${poolerHost}:5432/postgres`;

console.log(`\nSession pooler host: ${poolerHost}`);
console.log(`Project ref:         ${projectRef}`);
console.log('Connection string (keep the password secret):');
console.log(`  ${url.replace(encPassword, '***')}`);

// ─── 5. Prove it: migrations + verification against the real database ──────
console.log('\nRunning migrations + verification against the new database...\n');
process.env.DATABASE_URL = url;
process.env.USE_MEMORY_DB = '0';

try {
  const { runMigrations } = await import(
    new URL('../server/dist/db/migrate.js', import.meta.url).href
  );
  await runMigrations();
  console.log('\nMigrations applied.');

  // Full suite (bootstrap idempotency, round-trip, recap, cascades).
  const { spawnSync } = await import('node:child_process');
  const verify = spawnSync(process.execPath, ['scripts/verify-postgres.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url, USE_MEMORY_DB: '0' },
  });
  if (verify.status !== 0) {
    console.error('\nVerification FAILED — check the connection string/host above.');
    process.exit(verify.status ?? 1);
  }
} catch (e) {
  console.error(`\nDatabase verification failed: ${e?.message ?? e}`);
  console.error(
    'If this is a DNS/connection error, the pooler host guess was wrong — copy the\n' +
      '"Session pooler" URI from Supabase → Project Settings → Database and use it as DATABASE_URL.',
  );
  process.exit(1);
}

// ─── 6. Env vars for Railway ───────────────────────────────────────────────
console.log('\n' + '='.repeat(68));
console.log('Set these on Railway (Variables):');
console.log('='.repeat(68));
console.log(`DATABASE_URL=${url}`);
console.log('USE_MEMORY_DB=0');
console.log('# leave DATABASE_SSL unset (TLS is automatic for non-localhost hosts)');
console.log('# JWT_SECRET is also REQUIRED once DATABASE_URL is set (prod hard-fails without it)');
console.log('\nProduction database ref (used in backups and dashboard URLs):');
console.log(`  ${projectRef}`);
console.log('\nNext: add the DATABASE_URL repo secret so the nightly backup workflow runs');
console.log('  Repo → Settings → Secrets and variables → Actions → DATABASE_URL');
