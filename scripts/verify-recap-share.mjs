// Verify recap share links (FIX 3): signed, expiring recap links.
// Run against a live local server on :3001 (memory DB).
// Expected: all checks print PASS.
const BASE = 'http://localhost:3001';
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const createRoom = async () => {
  const r = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'share-test', userId: 'share-tester' }),
  });
  return r.json();
};

(async () => {
  console.log('=== Recap share links ===\n');

  // 1. Share endpoint requires a valid room token
  const room = await createRoom();
  const { id } = room.room;

  let r = await fetch(`${BASE}/api/rooms/${id}/recap/share`);
  check('share: no token -> 401', r.status === 401, `got ${r.status}`);

  r = await fetch(`${BASE}/api/rooms/${id}/recap/share`, {
    headers: { Authorization: `Bearer ${room.token}` },
  });
  const shareBody = r.status === 200 ? await r.json() : null;
  check('share: valid token -> 200', r.status === 200, `got ${r.status}`);
  check('share: returns url with ?share=', Boolean(shareBody?.url?.includes(`/recap/${id}?share=`)), shareBody?.url ?? 'no url');

  // 2. A different room's token cannot mint a share link for this room
  const room2 = await createRoom();
  r = await fetch(`${BASE}/api/rooms/${id}/recap/share`, {
    headers: { Authorization: `Bearer ${room2.token}` },
  });
  check('share: token for DIFFERENT room -> 403', r.status === 403, `got ${r.status}`);

  // 3. The minted share link can read the recap WITHOUT a room token
  const shareToken = shareBody.url.split('share=')[1];
  r = await fetch(`${BASE}/api/rooms/${id}/recap?share=${shareToken}`);
  check('recap: via share link -> 200 (no room token)', r.status === 200, `got ${r.status}`);

  // 4. Share token is not a room token — must not be accepted as Bearer
  r = await fetch(`${BASE}/api/rooms/${id}/recap`, {
    headers: { Authorization: `Bearer ${shareToken}` },
  });
  check('recap: share token used as Bearer -> 401', r.status === 401, `got ${r.status}`);

  // 5. Share link for room A must not open room B
  r = await fetch(`${BASE}/api/rooms/${room2.room.id}/recap?share=${shareToken}`);
  check('recap: share link for OTHER room -> 403', r.status === 403, `got ${r.status}`);

  // 6. Garbage share token rejected
  r = await fetch(`${BASE}/api/rooms/${id}/recap?share=garbage.token.here`);
  check('recap: garbage share token -> 401', r.status === 401, `got ${r.status}`);

  // 7. No credential at all still rejected (no regression)
  r = await fetch(`${BASE}/api/rooms/${id}/recap`);
  check('recap: no credential -> 401', r.status === 401, `got ${r.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
