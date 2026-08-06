// Dev orchestrator: starts the MeetPlay backend (in-memory DB — no Postgres
// needed) and the Vite frontend together, so `npm run dev` gives a fully
// working app with zero external services.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Load .env (local secrets: LiveKit cloud keys etc.). Safe if missing.
// process.loadEnvFile is available in Node >= 20.12.
try {
  if (fs.existsSync(path.resolve('.env'))) {
    process.loadEnvFile(path.resolve('.env'));
    console.log('[dev] Loaded .env');
  }
} catch (e) {
  console.warn('[dev] Could not load .env:', e.message);
}

const serverEnv = {
  ...process.env,
  USE_MEMORY_DB: '1',
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

console.log('[dev] Starting MeetPlay backend on :3001 (in-memory DB)…');

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
