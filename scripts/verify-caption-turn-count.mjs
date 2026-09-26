/**
 * Proves the half of the split-sentence fix that must NOT change: the server's
 * word accounting still counts a resumed Flux turn EXACTLY ONCE.
 *
 * A resumed turn arrives as two finals — the eager one in full ("we should
 * ship"), then the refined one carrying only the new tail ("it friday"). `text`
 * is the countable payload (the tail), while the turn's full text rides along as
 * `turnText` + `turnSeq` so display surfaces can render one sentence as one line.
 *
 * The risk this locks down: if the caption path ever fed `turnText` to the game
 * engine, or dropped `text` in favour of it, Word Count Guess, bingo marks,
 * speaker stats and the recap pool would silently inflate or lose words — the
 * kind of bug that surfaces as a wrong score, never as a crash.
 *
 * Asserts:
 *   1. the broadcast carries turnText/turnSeq through to clients
 *   2. the broadcast's `text` stays the tail (the countable payload)
 *   3. the engine's word count for the pair is the WHOLE sentence (5 words) —
 *      not the doubled 8, not the 2 of a dropped tail
 *   4. a caption WITHOUT turn fields still counts exactly as before, and is not
 *      given a turn identity it never had
 *   5. the PERSISTED transcript — what the recap page and its .txt download
 *      render — joins the pair back into one line, because the turn identity is
 *      stored beside the countable tail (server/src/db/migrate.ts +
 *      server/src/stt/turnText.ts). The rows themselves keep the tail: this is
 *      a read-time join, never a re-count.
 *
 * Usage (from the repo root):
 *   node scripts/verify-caption-turn-count.mjs
 */

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3227;
const BASE = `http://localhost:${PORT}`;
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const server = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    USE_MEMORY_DB: '1',
    DATABASE_URL: '',
    PORT: String(PORT),
    JWT_SECRET: 'caption-turn-secret',
    LIVEKIT_URL: '',
    LIVEKIT_API_KEY: '',
    LIVEKIT_API_SECRET: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

function socket(roomId, participantId, token) {
  // URLSearchParams, not string interpolation: a JWT interpolated into a URL
  // query silently produced a rejected socket in this repo before.
  const url = new URL(`ws://localhost:${PORT}/ws`);
  url.searchParams.set('roomId', roomId);
  url.searchParams.set('participantId', participantId);
  url.searchParams.set('token', token);
  const ws = new WebSocket(url);
  const inbox = [];
  const events = [];
  ws.on('message', (raw) => {
    try {
      inbox.push(JSON.parse(raw.toString()));
    } catch {}
  });
  ws.on('close', (code, reason) => events.push(`close ${code} ${reason?.toString() ?? ''}`.trim()));
  ws.on('error', (e) => events.push(`error ${e?.message ?? e}`));
  const wait = async (pred, ms, label) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await sleep(100);
    }
    throw new Error(
      `timed out waiting for ${label} — frames: [${inbox.map((m) => m.type).join(', ')}] socket: [${events.join('; ')}]`,
    );
  };
  return { ws, inbox, wait, open: new Promise((r) => ws.on('open', r)) };
}

/** The engine broadcasts stats every 3s while dirty; wait for the count to land. */
const waitWords = async (sock, participantId, atLeast, ms = 15000) => {
  const start = Date.now();
  let seen = null;
  while (Date.now() - start < ms) {
    const frames = sock.inbox.filter((m) => m.type === 'stats:update');
    const row = (frames.at(-1)?.payload?.stats ?? []).find((r) => r.participantId === participantId);
    if (row) {
      seen = row.words;
      if (row.words >= atLeast) return row.words;
    }
    await sleep(250);
  }
  return seen;
};

let roomId = null;
let hostToken = null;

try {
  const start = Date.now();
  let up = false;
  while (Date.now() - start < 30000) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) {
        up = true;
        break;
      }
    } catch {}
    await sleep(250);
  }
  check('server boots', up);

  const created = await (
    await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'caption-turn-check', userId: 'turn-host' }),
    })
  ).json();
  roomId = created.room.id;
  hostToken = created.token;
  const hostId = created.participant.id;

  const sock = socket(roomId, hostId, hostToken);
  await sock.open;
  await sock.wait((m) => m.type === 'room:state', 8000, 'initial room:state');
  check('host WebSocket connected and joined', true);

  const send = (payload) => sock.ws.send(JSON.stringify({ type: 'caption:event', payload }));
  const isCaption = (text) => (m) => m.type === 'caption:event' && m.payload?.text === text;

  // ─── The resumed turn, exactly as DeepgramAdapter emits it ───────────────
  send({ speakerId: 'local', text: 'we should ship', turnText: 'we should ship', turnSeq: 7, isFinal: true, confidence: 0.95 });
  const eager = await sock.wait(isCaption('we should ship'), 5000, 'eager final');
  check('the eager final is broadcast', Boolean(eager));

  send({ speakerId: 'local', text: 'it friday', turnText: 'we should ship it friday', turnSeq: 7, isFinal: true, confidence: 0.95 });
  const refined = await sock.wait(isCaption('it friday'), 5000, 'refined tail final');
  check('the refined tail final is broadcast', Boolean(refined));

  check(
    'the countable payload stays the tail',
    refined?.payload?.text === 'it friday',
    `text="${refined?.payload?.text}"`,
  );
  check(
    'the turn text reaches clients, so display can join the line',
    refined?.payload?.turnText === 'we should ship it friday',
    `turnText="${refined?.payload?.turnText}"`,
  );
  check(
    'the turn identity reaches clients, so display can tell it from a new sentence',
    refined?.payload?.turnSeq === 7,
    `turnSeq=${refined?.payload?.turnSeq}`,
  );

  // ─── The counting constraint: one sentence, counted once ─────────────────
  // "we should ship it friday" = 5 words. Double counting the shared prefix
  // would report 8; feeding only turnText would report 10; dropping the tail
  // would report 3... the correct answer is exactly 5.
  const resumedWords = await waitWords(sock, hostId, 5);
  check(
    'a resumed turn counts as the whole sentence, exactly once',
    resumedWords === 5,
    `words=${resumedWords} (expected 5: not 8 doubled, not 3 dropped)`,
  );

  // ─── A caption with no turn fields (mock/webspeech/v1) is unchanged ──────
  send({ speakerId: 'local', text: 'hello from the past', isFinal: true, confidence: 0.95 });
  const plain = await sock.wait(isCaption('hello from the past'), 5000, 'plain final');
  check('a caption without turn fields is still broadcast', Boolean(plain));
  check(
    'it is not given a turn identity it never had',
    plain?.payload?.turnSeq === undefined && plain?.payload?.turnText === undefined,
    `turnSeq=${plain?.payload?.turnSeq} turnText="${plain?.payload?.turnText}"`,
  );
  const totalWords = await waitWords(sock, hostId, 9);
  check(
    'plain finals still add up exactly (5 + 4)',
    totalWords === 9,
    `words=${totalWords}`,
  );

  // ─── The same turn, as the recap reads it back ───────────────────────────
  // transcript_events keeps the countable tail plus the turn's identity, so the
  // recap joins the sentence instead of printing "we should ship" and "it friday"
  // as two lines (and the .txt download with it).
  const recapRes = await fetch(`${BASE}/api/rooms/${roomId}/recap`, {
    headers: { authorization: `Bearer ${hostToken}` },
  });
  check('recap is readable', recapRes.ok, `status=${recapRes.status}`);
  const recap = await recapRes.json();
  const lines = recap?.transcript ?? [];
  check('recap transcript joins the resumed turn into one line', lines.length === 2, `lines=${lines.length}`);
  check(
    'the joined line reads the whole sentence',
    lines[0]?.text === 'we should ship it friday',
    `text="${lines[0]?.text}"`,
  );
  check(
    'the plain caption is still its own line',
    lines[1]?.text === 'hello from the past',
    `text="${lines[1]?.text}"`,
  );

  sock.ws.close();
} catch (e) {
  console.error('\nAborted:', e?.message ?? e);
  failures++;
} finally {
  if (roomId && hostToken) {
    try {
      await fetch(`${BASE}/api/rooms/${roomId}/end`, {
        method: 'POST',
        headers: { authorization: `Bearer ${hostToken}` },
      });
    } catch {}
  }
  server.kill('SIGTERM');
  await sleep(400);
  server.kill('SIGKILL');
}

if (failures > 0) {
  console.log('\n--- server log tail ---');
  console.log(log.split('\n').slice(-25).join('\n'));
}
console.log(
  failures === 0
    ? '\nResumed turns reach display intact, and word counts are unchanged.'
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
