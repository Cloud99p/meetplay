/**
 * Verifies /health tells the truth about the database, and that a server which
 * cannot reach its schema refuses to start.
 *
 * Bug this locks down: /health answered {"ok":true} while every data route 500'd
 * because Postgres was rejecting the credentials — a deploy that looks green in the
 * dashboard and is broken for users.
 *
 * The Postgres cases bring up their OWN throwaway database (trust auth, no password).
 * That is deliberate: an earlier version of this file carried a hardcoded fallback
 * credential, it drifted from the container's, and a failed login looked exactly like
 * a product bug. A test should not be able to fail for reasons unrelated to the code.
 * Set TEST_DATABASE_URL (and TEST_DB_CONTAINER) to point at an existing database
 * instead — CI does that; locally we just use docker.
 *
 * Usage (from the repo root):
 *   node scripts/verify-health.mjs
 */

import { spawn, execFileSync } from 'node:child_process';

const PORT = 3223;
const BASE = `http://localhost:${PORT}`;
const THROWAWAY = 'meetplay-pg-health';
const THROWAWAY_PORT = 55433;
const BAD_DB = 'postgres://nobody@127.0.0.1:5599/absent'; // nothing listens here

let failures = 0;
let db = null; // { url, container, owned }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
};

function docker(args) {
  return execFileSync('docker', args, { stdio: 'pipe' }).toString();
}

/** An existing database if the caller provides one, else a throwaway of our own. */
async function ensureDb() {
  if (process.env.TEST_DATABASE_URL) {
    return { url: process.env.TEST_DATABASE_URL, container: process.env.TEST_DB_CONTAINER ?? null, owned: false };
  }
  try {
    docker(['rm', '-f', THROWAWAY]);
  } catch {
    /* not there */
  }
  try {
    docker([
      'run', '-d', '--name', THROWAWAY,
      // trust auth: no password anywhere, so no credential can drift
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-p', `${THROWAWAY_PORT}:5432`,
      'postgres:17',
    ]);
  } catch (e) {
    console.log(`SKIP  could not start a throwaway Postgres (docker: ${e.message.split('\n')[0]})`);
    return null;
  }
  const start = Date.now();
  while (Date.now() - start < 90000) {
    try {
      docker(['exec', THROWAWAY, 'pg_isready', '-U', 'postgres', '-q']);
      await sleep(1200); // let the first-boot entrypoint finish
      return { url: `postgres://postgres@localhost:${THROWAWAY_PORT}/postgres`, container: THROWAWAY, owned: true };
    } catch {
      await sleep(1000);
    }
  }
  console.log('SKIP  throwaway Postgres never became ready');
  return null;
}

function startServer(env, port = PORT) {
  const child = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      USE_MEMORY_DB: '',
      DATABASE_URL: '',
      PORT: String(port),
      JWT_SECRET: 'verify-health-secret',
      LIVEKIT_URL: '',
      LIVEKIT_API_KEY: '',
      LIVEKIT_API_SECRET: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  return { child, getLog: () => log };
}

async function health(port = PORT) {
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

async function waitForHealth(predicate, timeoutMs, port = PORT) {
  const start = Date.now();
  let last = { status: 0, body: null };
  while (Date.now() - start < timeoutMs) {
    last = await health(port);
    if (predicate(last)) return last;
    await sleep(500);
  }
  return last;
}

console.log('Health endpoint\n');

// ─── A. In-memory backend: healthy, and it names the backend ────────────────
{
  const { child } = startServer({ USE_MEMORY_DB: '1' });
  const h = await waitForHealth((r) => r.status === 200, 25000);
  check('memory backend reports healthy', h.status === 200, `status=${h.status}`);
  check('health names the backend', h.body?.db === 'memory', JSON.stringify(h.body));
  child.kill('SIGKILL');
  await sleep(300);
}

// ─── B. Unreachable database: refuse to start rather than serve 500s ────────
{
  const { child, getLog } = startServer({ DATABASE_URL: BAD_DB });
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 60000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
  check('unreachable schema stops the boot (non-zero exit)', exited !== null && exited !== 0, `exit=${exited}`);
  check('and it says why', /refusing to start with a broken database/.test(getLog()));
  const h = await health();
  check('nothing is served in that state', h.status === 0, `status=${h.status}`);
  child.kill('SIGKILL');
  await sleep(300);
}

// ─── C. Escape hatch: DB_STRICT_START=0 boots anyway, /health says so ───────
{
  const { child, getLog } = startServer({ DATABASE_URL: BAD_DB, DB_STRICT_START: '0' }, PORT + 1);
  await waitForHealth((r) => r.status !== 0, 45000, PORT + 1);
  const served = await health(PORT + 1);
  check('DB_STRICT_START=0 starts degraded instead of exiting', /starting anyway/.test(getLog()));
  check(
    'degraded server answers 503, not a false "ok"',
    served.status === 503 && served.body?.db === 'down',
    `status=${served.status} body=${JSON.stringify(served.body)}`,
  );
  child.kill('SIGKILL');
  await sleep(300);
}

// ─── D. Database dies AFTER boot: health must flip to 503, then recover ─────
db = await ensureDb();
if (!db) {
  console.log('SKIP  no database available for the runtime-failure case');
} else {
  const { child } = startServer({ DATABASE_URL: db.url });
  const healthy = await waitForHealth((r) => r.status === 200, 60000);
  check(
    'postgres backend reports healthy',
    healthy.status === 200 && healthy.body?.db === 'postgres',
    `status=${healthy.status} body=${JSON.stringify(healthy.body)}`,
  );

  if (!db.container) {
    console.log('SKIP  TEST_DATABASE_URL without TEST_DB_CONTAINER: cannot simulate a DB outage');
  } else {
    docker(['stop', db.container]);

    // The outage must not take the process with it: a crash would mean the
    // platform restarts us blind instead of /health reporting the truth.
    await sleep(500);
    check('server process survives a database outage', child.exitCode === null, `exitCode=${child.exitCode}`);
    const down = await waitForHealth((r) => r.status === 503, 30000);
    check(
      'health flips to 503 once the database is gone',
      down.status === 503 && down.body?.ok === false,
      `status=${down.status} body=${JSON.stringify(down.body)}`,
    );

    docker(['start', db.container]);
    const back = await waitForHealth((r) => r.status === 200, 90000);
    check('and recovers when the database returns', back.status === 200, `status=${back.status}`);
  }

  child.kill('SIGKILL');
  await sleep(300);
}

// Clean up only what we created.
if (db?.owned) {
  try {
    docker(['rm', '-f', THROWAWAY]);
    console.log('\nthrowaway database removed');
  } catch {
    /* ignore */
  }
}

console.log(failures === 0 ? '\nHealth tells the truth.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
