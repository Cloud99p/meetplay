// Proves that MeetPlay room data PERSISTS across backend restarts (i.e. the
// server is really using Postgres, not the in-memory store).
//
// Usage:
//   node --env-file=.env scripts/verify-persistence.mjs create [--base=http://127.0.0.1:3001]
//        -> creates a room through the API and checks the row exists in Postgres.
//           Prints: ROOM_ID=<uuid>
//   ...restart the backend...
//   node --env-file=.env scripts/verify-persistence.mjs check <roomId>
//        -> re-reads the room through the API + directly in Postgres.
//   node --env-file=.env scripts/verify-persistence.mjs cleanup <roomId>
//        -> deletes the test room (and its rows via FK cascade).
//
// Exit code 0 = pass, 1 = fail.

import pg from 'pg';

const [cmd, arg] = process.argv.slice(2);
const baseArg = process.argv.find((a) => a.startsWith('--base='));
const BASE = baseArg ? baseArg.split('=')[1] : 'http://127.0.0.1:3001';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (use --env-file=.env)');
  process.exit(1);
}
const useSsl = process.env.DATABASE_SSL
  ? process.env.DATABASE_SSL
  : /localhost|127\.0\.0\.1/.test(url)
    ? 'disable'
    : 'require';
const pool = new pg.Pool({
  connectionString: url,
  max: 2,
  ssl: useSsl === 'disable' ? false : { rejectUnauthorized: useSsl === 'verify' },
});

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}

try {
  if (cmd === 'create') {
    const res = await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `persistence-check ${new Date().toISOString()}` }),
    });
    check('POST /api/rooms returns 201', res.status === 201, `status=${res.status}`);
    const body = await res.json();
    const roomId = body?.room?.id;
    check('response carries a room id', Boolean(roomId), String(roomId));
    if (!roomId) throw new Error('no room id');

    const { rows } = await pool.query(
      'select id, name, state, created_at from rooms where id = $1',
      [roomId],
    );
    check('room row exists in Postgres (not just in memory)', rows.length === 1);
    const { rows: parts } = await pool.query(
      'select count(*)::int as n from participants where room_id = $1',
      [roomId],
    );
    check('host participant row exists in Postgres', parts[0].n >= 1, `participants=${parts[0].n}`);

    console.log(`\nROOM_ID=${roomId}`);
    console.log('Now restart the backend, then: ' +
      `node --env-file=.env scripts/verify-persistence.mjs check ${roomId}`);
  } else if (cmd === 'check') {
    if (!arg) throw new Error('usage: check <roomId>');
    check('room is still in Postgres after restart', (await pool.query(
      'select 1 from rooms where id = $1', [arg],
    )).rows.length === 1);

    const res = await fetch(`${BASE}/api/rooms/${arg}`);
    check('GET /api/rooms/:id returns 200 after restart', res.status === 200, `status=${res.status}`);
    if (res.status === 200) {
      const body = await res.json();
      check('API returns the same room id', body?.room?.id === arg || body?.id === arg,
        JSON.stringify(body?.room?.id ?? body?.id));
    }
  } else if (cmd === 'cleanup') {
    if (!arg) throw new Error('usage: cleanup <roomId>');
    const { rowCount } = await pool.query('delete from rooms where id = $1', [arg]);
    check('test room deleted', rowCount === 1, `deleted=${rowCount}`);
    const { rows } = await pool.query(
      'select (select count(*)::int from participants where room_id=$1) as p, ' +
      '(select count(*)::int from chat_messages where room_id=$1) as c', [arg],
    );
    check('no orphan rows left', rows[0].p === 0 && rows[0].c === 0, JSON.stringify(rows[0]));
  } else {
    console.error('usage: create | check <roomId> | cleanup <roomId>');
    process.exit(1);
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
console.log(failures === 0 ? '\nOK' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? process.exitCode ?? 0 : 1;
