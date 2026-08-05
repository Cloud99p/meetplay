// Identity layer test: unique names per room + same-user rejoin.
// Usage: node scripts/identity-test.mjs <port>
const PORT = Number(process.argv[2] || 3210);
const BASE = `http://localhost:${PORT}`;
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const createRoom = async (userId, name) => {
  const r = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: undefined, userId, hostName: name }),
  });
  return { status: r.status, body: await r.json() };
};

const join = async (roomId, participantName, userId) => {
  const r = await fetch(`${BASE}/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantName, userId }),
  });
  return { status: r.status, body: await r.json() };
};

try {
  // 1. Create room as user A
  const created = await createRoom('user-a', 'Alice');
  ok('create room (user A)', created.status === 201, `room=${created.body.room?.id?.slice(0,8)}`);
  const roomId = created.body.room.id;

  // 2. User B joins with unique name
  const b = await join(roomId, 'Bob', 'user-b');
  ok('user B joins with unique name', b.status === 201);

  // 3. User C tries the same name as B → 409
  const c = await join(roomId, 'Bob', 'user-c');
  ok('duplicate name rejected (409)', c.status === 409, c.body?.error ?? '');

  // 4. User B rejoins under same name (same userId) → allowed
  const b2 = await join(roomId, 'Bob', 'user-b');
  ok('same-user rejoin allowed', b2.status === 201);

  const failed = results.filter((r) => !r).length;
  console.log(`\n=== ${results.length - failed}/${results.length} passed ===`);
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
