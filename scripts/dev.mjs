// Dev orchestrator: starts the MeetPlay backend and the Vite frontend together,
// so `npm run dev` gives a fully working app.
//
// DATABASE MODE: the backend uses whatever the loaded env file says.
// `.env.dev` is preferred; `.env` is the fallback (it points at PRODUCTION).
//   USE_MEMORY_DB=0 + DATABASE_URL  -> real Postgres — data PERSISTS
//                                      across restarts/sessions
//   USE_MEMORY_DB=1 (or no DATABASE_URL) -> in-memory store, resets every boot
// Default when unset: Postgres if DATABASE_URL is present, else in-memory.
//
// Set ENV_FILE=<path> to force a specific env file (also disables the
// production-DB guard, since that is an explicit choice).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Load the local environment. Prefer `.env.dev` so `npm run dev` can never
// write to the production database that `.env` points at; fall back to `.env`
// only when no dev file exists, and say which one was used.
// process.loadEnvFile is available in Node >= 20.12.
//
// Set ENV_FILE=<path> to force a specific file (bypasses the dev guard below,
// since you are then choosing the environment explicitly).
const FORCED_ENV_FILE = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : null;
const ENV_DEV_FILE = path.resolve('.env.dev');
const ENV_FILE = path.resolve('.env');
const envFile = FORCED_ENV_FILE ?? (fs.existsSync(ENV_DEV_FILE) ? ENV_DEV_FILE : ENV_FILE);
const usedDevFile = !FORCED_ENV_FILE && fs.existsSync(ENV_DEV_FILE);
const isForced = FORCED_ENV_FILE !== null;
try {
  if (fs.existsSync(envFile)) {
    process.loadEnvFile(envFile);
    console.log(
      `[dev] Loaded ${path.basename(envFile)}` +
        (isForced
          ? ' (forced via ENV_FILE)'
          : usedDevFile
            ? ' (dev environment)'
            : ' (fallback — no .env.dev found)'),
    );
  }
} catch (e) {
  console.warn('[dev] Could not load env file:', e.message);
}

// LOUD GUARD: dev must never point at the production Supabase database.
// Refusing to start is the whole point — a silent fallback is how local
// development ends up writing to live pilot data (see RESUME-HERE gotcha #9).
// Skipped when ENV_FILE forced a file, because that is an explicit choice.
const PROD_DB_HOST = 'aws-0-eu-west-2.pooler.supabase.com';
if (isForced) {
  console.warn(
    `[dev] ENV_FILE=${path.basename(envFile)} forced — the production-DB guard is OFF.`,
  );
}
if (usedDevFile) {
  const dbUrl = process.env.DATABASE_URL ?? '';
  if (dbUrl.includes(PROD_DB_HOST)) {
    console.error(
      `\n[dev] REFUSING TO START: ${path.basename(envFile)} sets DATABASE_URL to the\n` +
        `      PRODUCTION database (${PROD_DB_HOST}).\n` +
        `      Remove DATABASE_URL from ${path.basename(envFile)}, or set USE_MEMORY_DB=1.\n` +
        '      If you really mean it, set ENV_FILE=.env and be aware you are touching pilot data.\n',
    );
    process.exit(1);
  }
  if (process.env.USE_MEMORY_DB !== '1' && !dbUrl) {
    console.warn(
      '[dev] Neither DATABASE_URL nor USE_MEMORY_DB=1 is set — the server will ' +
        'fall back to the in-memory store.',
    );
  }
} else if (!isForced) {
  console.warn(
    '[dev] No .env.dev found — falling back to .env, which points at PRODUCTION.\n' +
      '      Copy .env.example to .env.dev and set USE_MEMORY_DB=1 for safe local work.',
  );
}

// Respect an explicit USE_MEMORY_DB from .env; otherwise fall back to real
// Postgres whenever a DATABASE_URL is configured (that's the whole point of
// having one), and only use the in-memory store when there's no database.
const useMemoryDb =
  process.env.USE_MEMORY_DB ?? (process.env.DATABASE_URL ? '0' : '1');

/** Never print credentials — show host + db name only. */
function maskDb(url) {
  if (!url) return 'unset';
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return 'configured';
  }
}

const serverEnv = {
  ...process.env,
  USE_MEMORY_DB: useMemoryDb,
  JWT_SECRET: process.env.JWT_SECRET ?? 'meetplay-dev-secret',
  // LiveKit credentials come ONLY from .env / env — no committed fallbacks.
  // Copy .env.example to .env and fill in LIVEKIT_URL/API_KEY/API_SECRET
  // (get them from https://cloud.livekit.io) for video to work in dev.
  LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY ?? '',
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET ?? '',
  LIVEKIT_URL: process.env.LIVEKIT_URL ?? '',
  // Backend port is decoupled from PORT (Railway injects PORT for the public
  // entry; we keep the backend on 3001 and expose Vite on 5173).
  PORT: process.env.BACKEND_PORT ?? '3001',
};

if (!serverEnv.LIVEKIT_URL || !serverEnv.LIVEKIT_API_KEY || !serverEnv.LIVEKIT_API_SECRET) {
  console.warn(
    '[dev] LiveKit env vars missing (LIVEKIT_URL/API_KEY/API_SECRET) — video/audio will be ' +
      'unavailable. Copy .env.example to .env and fill them in, or run `docker compose up livekit`.',
  );
}

const LIVEKIT_HTTP_PORT = 7880;

// Start a local LiveKit server so video/audio work in the preview without
// Docker. Falls back gracefully when the binary isn't installed (chat and
// games still work; the client reports LiveKit as unavailable).
let livekit = null;
function ensureLiveKit() {
  if (serverEnv.LIVEKIT_URL !== 'ws://localhost:7880') {
    console.log('[dev] Using external LiveKit at', serverEnv.LIVEKIT_URL);
    return;
  }
  if (process.env.LIVEKIT_DISABLE === '1') return;

  // Already running? (e.g. started outside this orchestrator)
  const probe = spawnSync('sh', ['-c', 'curl -s --max-time 2 -o /dev/null http://localhost:7880/']);
  if (probe.status === 0) {
    console.log('[dev] LiveKit already running on :7880, reusing it.');
    return;
  }

  const bin = spawnSync('sh', ['-c', 'command -v livekit-server']);
  if (bin.status !== 0) {
    console.log('[dev] livekit-server binary not found — attempting auto-install…');
    const install = spawnSync(
      'sh',
      ['-c',
        'curl -sL https://github.com/livekit/livekit/releases/download/v1.6.1/livekit_1.6.1_linux_amd64.tar.gz | tar -xz -C /usr/local/bin livekit-server'
      ],
      { stdio: 'pipe' }
    );
    if (install.status !== 0) {
      console.warn(
        '[dev] Auto-install failed — video/audio will be unavailable.\n' +
        '      Install manually: curl -sL https://github.com/livekit/livekit/releases/download/v1.6.1/livekit_1.6.1_linux_amd64.tar.gz | tar -xz -C /usr/local/bin livekit-server\n' +
        '      (or run `docker compose up livekit` and set LIVEKIT_URL accordingly).'
      );
      return;
    }
    console.log('[dev] livekit-server installed.');
  }

  const configPath = path.resolve('livekit.yaml');
  if (!fs.existsSync(configPath)) {
    console.warn('[dev] livekit.yaml not found — skipping local LiveKit start.');
    return;
  }

  console.log('[dev] Starting local LiveKit server on :7880…');
  livekit = spawn('livekit-server', ['--config', configPath], {
    stdio: 'inherit',
    env: { ...process.env, LIVEKIT_KEYS: undefined },
    shell: process.platform === 'win32',
  });
  livekit.on('exit', (code) => {
    if (!shuttingDown && code && code !== 0) {
      console.error(`[dev] LiveKit server exited with code ${code}`);
    }
  });
}

ensureLiveKit();

console.log(
  `[dev] Starting MeetPlay backend on :${serverEnv.PORT} ` +
    (useMemoryDb === '1'
      ? '(in-memory DB — data resets on restart)'
      : `(Postgres — data persists, ${maskDb(process.env.DATABASE_URL)})`),
);

const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  stdio: 'inherit',
  env: serverEnv,
  shell: process.platform === 'win32',
});

const vite = spawn('npx', ['vite', '--host', '0.0.0.0', '--port', '5173'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[dev] Received ${signal}, shutting down…`);
  server.kill('SIGTERM');
  vite.kill('SIGTERM');
  if (livekit) livekit.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.on('exit', (code) => {
  if (!shuttingDown && code !== 0) {
    console.error(`[dev] Backend exited with code ${code}`);
    vite.kill('SIGTERM');
    process.exit(code ?? 1);
  }
});
