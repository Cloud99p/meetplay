// Security fixes verification (FIX 1-5). Run against localhost:3001 directly.
// Expected: all checks print PASS.
const BASE = 'http://localhost:3001';
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

// ── helpers ──
const createRoom = async (password) => {
  const r = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'sec-test', password, userId: 'tester-1' }),
  });
  return r.json();
};
const joinRoom = async (roomId, name, password) => {
  const r = await fetch(`${BASE}/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password, userId: 'tester-' + name }),
  });
  return { status: r.status, body: await r.json() };
};
const sendChat = async (roomId, token) => {
  await fetch(`${BASE}/api/rooms/${roomId}/chat`, { // may 404 if route differs; chat normally goes over WS
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content: 'hello' }),
  }).catch(() => {});
};

(async () => {
  console.log('=== FIX 1: recap + messages require room token ===\n');
  const room = await createRoom('pw123');
  const { id } = room.room;

  let r = await fetch(`${BASE}/api/rooms/${id}/messages`);
  check('messages: no token -> 401', r.status === 401, `got ${r.status}`);

  r = await fetch(`${BASE}/api/rooms/${id}/recap`);
  check('recap: no token -> 401', r.status === 401, `got ${r.status}`);

  r = await fetch(`${BASE}/api/rooms/${id}/recap`, {
    headers: { Authorization: `Bearer ${room.token}` },
  });
  check('recap: valid token -> 200', r.status === 200, `got ${r.status}`);

  r = await fetch(`${BASE}/api/rooms/${id}/messages`, {
    headers: { Authorization: `Bearer ${room.token}` },
  });
  check('messages: valid token -> 200', r.status === 200, `got ${r.status}`);

  // Wrong room token (create another room, use its token on this room)
  const room2 = await createRoom();
  r = await fetch(`${BASE}/api/rooms/${id}/recap`, {
    headers: { Authorization: `Bearer ${room2.token}` },
  });
  check('recap: token for DIFFERENT room -> 403', r.status === 403, `got ${r.status}`);

  // Garbage token
  r = await fetch(`${BASE}/api/rooms/${id}/recap`, {
    headers: { Authorization: 'Bearer garbage.token.here' },
  });
  check('recap: garbage token -> 401', r.status === 401, `got ${r.status}`);

  console.log('\n=== FIX 2: server-side password lockout ===\n');
  // fresh room with password
  const pRoom = await createRoom('secret99');
  // 5 wrong attempts
  for (let i = 1; i <= 5; i++) {
    const j = await joinRoom(pRoom.room.id, `attacker${i}`, 'wrong');
    if (i < 5) check(`wrong pw attempt ${i} -> 401`, j.status === 401, `got ${j.status}`);
  }
  // 6th attempt should be locked out (429)
  const locked = await joinRoom(pRoom.room.id, 'attacker6', 'wrong');
  check('6th wrong attempt -> 429 lockout', locked.status === 429, `got ${locked.status} ${JSON.stringify(locked.body?.error ?? '')}`);
  // Even a CORRECT password is locked out during cooldown
  const correctLocked = await joinRoom(pRoom.room.id, 'attacker7', 'secret99');
  check('correct pw during lockout -> 429 (still blocked)', correctLocked.status === 429, `got ${correctLocked.status}`);

  // Different IP simulation is not possible locally (same IP) — but verify
  // that a DIFFERENT room is not affected by this room's lockout.
  const otherRoom = await createRoom('otherpw');
  const otherOk = await joinRoom(otherRoom.room.id, 'user1', 'otherpw');
  check('unrelated room join unaffected -> 201', otherOk.status === 201, `got ${otherOk.status}`);

  // Verified via a child process: loadConfig with NODE_ENV=production and no
  // JWT_SECRET must THROW (see scripts/verify-jwt-prod-boot.mjs). Runs under
  // tsx so .js->.ts import resolution matches the server runtime.
  const { execFileSync } = await import('node:child_process');
  const tsxBin = process.platform === 'win32'
    ? 'node_modules\\tsx\\dist\\cli.mjs'
    : 'node_modules/tsx/dist/cli.mjs';
  const runChild = (script) => {
    try {
      return execFileSync(process.execPath, [tsxBin, script], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'production' },
        stdio: 'pipe',
      }).toString();
    } catch (e) {
      return ((e.stdout ?? '').toString() + (e.stderr ?? '').toString());
    }
  };
  const jwtOut = runChild('scripts/verify-jwt-prod-boot.mjs');
  check('config throws in prod without JWT_SECRET', jwtOut.includes('THREW_AS_EXPECTED'));

  console.log('\n=== FIX 4: CORS restricted ===\n');
  r = await fetch(`${BASE}/api/rooms/${id}`, { headers: { Origin: 'https://evil.example.com' } });
  const allowOrigin = r.headers.get('access-control-allow-origin');
  check('evil origin -> no ACAO header', allowOrigin === null, `got ${allowOrigin ?? 'null'}`);

  console.log('\n=== FIX 5: cleanup job exists ===\n');
  const cleanupOut = runChild('scripts/verify-cleanup-job.mjs');
  check('runRoomCleanup() executes without error', cleanupOut.includes('CLEANUP_OK'));

  console.log(`\n==== ${pass} PASS, ${fail} FAIL ====`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
