# MeetPlay — `/api/rooms/:roomId/end` returns 400 Bad Request — Diagnosis

Date: 2026-08-09 · Status: DIAGNOSED, not fixed.

---

## TL;DR — Root cause

**The client's `request()` helper force-sets `Content-Type: application/json` on EVERY request, and `endRoom()` POSTs with NO body. Fastify 5's default JSON parser rejects an empty body with `Content-Type: application/json` as `FST_ERR_CTP_EMPTY_JSON_BODY` → HTTP 400 "Body cannot be empty when content-type is set to 'application/json'". The route handler never even runs.**

So the HTTP fallback for ending a meeting is **100% broken, always** — it fails identically on the first click and the hundredth. It only *looks* like "degrades after a while" because the primary end path is the WebSocket (`room:end`), which works while the WS is alive; when the WS dies mid-meeting (reconnect exhausts after ~5 attempts), the host is left with only the always-broken HTTP fallback, and the meeting can no longer be ended at all.

---

## 1. The `/end` route — `server/src/routes/rooms.ts`

```ts
// End meeting (host only)
app.post('/api/rooms/:id/end', async (req, reply) => {            // line ~201
  const { id } = req.params as { id: string };
  const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const payload = auth ? verifyRoomToken(auth) : null;
  if (!payload) return reply.code(401).send({ error: 'Invalid room token' });
  if (payload.roomId !== id) return reply.code(403).send({ error: 'Token does not match room' });

  const participant = await getParticipantById(payload.participantId);
  if (!participant || participant.room_id !== id) {
    return reply.code(403).send({ error: 'Host only' });
  }
  // Authoritative host check: the is_host flag can drift (promotion races),
  // so also accept the room's recorded host pointer.
  const roomRow = await getRoomById(id);
  if (!participant.is_host && roomRow?.host_participant_id !== participant.id) {
    return reply.code(403).send({ error: 'Host only' });
  }

  await endMeetingRoom(id);
  return reply.send({ ok: true });
});
```

**The route handler itself NEVER returns 400.** Status codes it can produce:

| Code | Condition |
|------|-----------|
| **400** | **Never from the handler. The observed 400 comes from Fastify's body parser (see §4).** |
| 401 | No `Authorization` header, or token invalid/expired (`verifyRoomToken` → null) |
| 403 | Token `roomId` ≠ `:id`; participant row missing or belongs to a different room; caller is not host (is_host false AND room `host_participant_id` ≠ participant.id) |
| 500 | `endMeetingRoom(id)` throws (DB failure in `updateRoom`; everything else inside is guarded — see §2) |
| 200 | `{ ok: true }` — always, on success. **No `state !== 'active'` check → no double-end guard. Second call also returns 200 (endMeetingRoom is idempotent).** |

**Double-end behavior:** Host clicking End twice, or WS `room:end` + HTTP `/end` both firing in parallel (the client does exactly this — see §6), does NOT produce a 400 or any error. `endMeetingRoom` is documented and verified idempotent. This is NOT the cause.

---

## 2. `server/src/endMeeting.ts` — what can make `endMeetingRoom` throw/fail

```ts
export async function endMeetingRoom(roomId: string): Promise<void> {
  await updateRoom(roomId, { state: 'ended', ended_at: new Date().toISOString() });
  const engine = getGameEngine(roomId);          // always returns an engine (creates fresh)
  await engine.resolveMarket();                  // throws only on engine/state bugs
  await engine.resolveFlashRound();
  await engine.resolveUserMarkets();
  await engine.saveRecapQuiz();
  omniClient.flushRoom(roomId).catch(() => {});  // non-blocking
  destroyGameEngine(roomId);                     // safe (Map delete)
  await stopRecordingForRoomEnd(roomId);         // try/catch inside, ignores all errors
  await deleteLiveKitRoom(roomId);               // try/catch inside; ignores NotFound (code 12)
  channelManager.broadcast(roomId, { type: 'room:ended', payload: {} });
  channelManager.closeRoom(roomId);
}
```

- `updateRoom` (memory store): no-op if room missing — **does not throw** (`server/src/db/memory.ts:104-111`).
- `updateRoom` (PG): UPDATE on missing row succeeds, affects 0 rows — no throw.
- `getGameEngine` (`server/src/games/engine.ts:1461-1468`): never null — creates a new engine if absent.
- `stopRecordingForRoomEnd` / `deleteLiveKitRoom`: fully guarded with try/catch.
- **Realistic throw paths: DB unreachable (PG pool error in `updateRoom`) → 500; a bug in an engine resolve/save method → 500.** A throw here would surface as 500, NOT the observed 400. So `endMeetingRoom` is not the source of the reported 400 — it is defensive and idempotent by design.

---

## 3. `server/src/utils/jwt.ts` — token expiry

```ts
export function generateRoomToken(payload: RoomTokenPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: '24h' });   // line 28
}
```

- **Room token TTL: 24 hours** (hardcoded in `generateRoomToken`). Secret from `loadConfig().jwtSecret` (`server/src/config.ts`; boot-time guard in production).
- `verifyRoomToken` returns `null` on expiry/any error → route returns **401**, not 400.
- **A meeting running >24h silently breaks ALL authed endpoints** (messages, livekit-token, transcript toggle, recap, end) with 401. This is a real latent issue for very long meetings and matches "everything starts quietly breaking" — but it produces 401, NOT the observed 400. **Not the cause of this specific bug, but a real secondary failure mode for >24h rooms.**

---

## 4. 🔴 THE SMOKING GUN — client request shape (why it 400s)

`src/lib/api.ts` — the shared request helper (line 81-90):

```ts
async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...opts,
    // Merge caller headers UNDER the defaults so Content-Type is never clobbered ...
    headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
  });
```

`src/lib/api.ts` — `endRoom` (line 183-187):

```ts
export async function endRoom(roomId: string, roomToken: string): Promise<void> {
  await request(`/api/rooms/${roomId}/end`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${roomToken}` },
  });
}
```

- `endRoom` sends **no `body`**, but `request()` forces `Content-Type: application/json`.
- Resulting request: `POST /api/rooms/:id/end` with header `Content-Type: application/json` and an **empty body** (`Content-Length: 0`).

Fastify 5 (`node_modules/fastify/lib/content-type-parser.js:313-317`) — the default JSON parser:

```js
function defaultJsonParser (req, body, done) {
  if (body.length === 0) {
    done(new FST_ERR_CTP_EMPTY_JSON_BODY(), undefined)
    return
  }
```

`node_modules/fastify/lib/errors.js:122-126`:

```js
FST_ERR_CTP_EMPTY_JSON_BODY: createError(
  'FST_ERR_CTP_EMPTY_JSON_BODY',
  "Body cannot be empty when content-type is set to 'application/json'",
  400
),
```

**The 400 fires during body parsing, before the route handler (and its auth checks) ever execute.** The client's error path reads `body.error` from Fastify's error envelope → `"Bad Request"` → console: `[meeting] endRoom HTTP fallback failed: Bad Request`. **Exact match with the reported log.**

Other Fastify-400 sources for this route (all client-side, none reach the handler): `FST_ERR_CTP_INVALID_JSON_BODY` (malformed JSON body), `FST_ERR_CTP_BODY_TOO_LARGE`, `FST_ERR_CTP_INVALID_CONTENT_LENGTH`. Rate limit is 429, unknown route is 404 — neither is the observed error.

---

## 5. `server/src/cleanup.ts` — can it kill an ACTIVE room mid-meeting?

**Yes, in principle — but only after 24h of no tracked activity, and it would produce 403/404, not 400.**

- Job: `startRoomCleanup()` runs every 60 min (`ROOM_CLEANUP_INTERVAL_MS`), purging rooms idle > `ROOM_RETENTION_HOURS` (default **24h**).
- Both backends purge **`state = 'active'`** rooms whose activity watermark is older than the cutoff:

  PG (`server/src/db/pgQueries.ts:385-398`):
  ```sql
  WHERE r.state = 'active'
    AND GREATEST(
      r.created_at,
      COALESCE((SELECT MAX(m.created_at) FROM chat_messages m WHERE m.room_id = r.id), r.created_at),
      COALESCE((SELECT MAX(t.created_at) FROM transcript_events t WHERE t.room_id = r.id), r.created_at),
      COALESCE((SELECT MAX(p.joined_at) FROM participants p WHERE p.room_id = r.id), r.created_at),
      COALESCE((SELECT MAX(COALESCE(g.ended_at, g.started_at)) FROM game_rounds g WHERE g.room_id = r.id), r.created_at)
    ) < NOW() - ($1::int * INTERVAL '1 hour')
  ```
  Memory store mirrors this (`server/src/db/memory.ts:283-311`).

- **Critical flaw: activity is measured by `p.joined_at` (join time), NOT "last seen".** There is no heartbeat/last-seen tracking anywhere. A participant who joined >24h ago and is still connected in LiveKit does NOT refresh the watermark. A long, quiet meeting (no chat, no speech → no `transcript_events`, no games) gets purged **while people are still actively connected**.
- Consequence if purged: FK cascade deletes participants → WS `checkIsHost` returns false → WS `room:end` handler **silently returns without ending** (`server/src/ws/handler.ts:480-485, 533-541`); HTTP `/end` → 403 "Host only" (participant gone). **Not 400 — but a genuine "everything quietly breaks" contributor for meetings >24h.**

---

## 6. Client end flow & why it "degrades after a while"

`src/hooks/useMeeting.ts` — `endMeeting` (line ~855):

```ts
const endMeeting = useCallback(() => {
  const token = api.getRoomToken();
  const roomId = roomIdRef.current;
  intentionallyLeftRef.current = true;
  reconnectInFlightRef.current = false;
  ws.send('room:end', {});                 // PRIMARY path
  if (token && roomId) {
    api.endRoom(roomId, token)             // FALLBACK path — always 400s (§4)
      .then(() => { /* local cleanup, navigate to recap */ })
      .catch((e) => console.error('[meeting] endRoom HTTP fallback failed:', e));
  }
}, [ws, liveKitRoom]);
```

- WS `room:end` → server `checkIsHost` → `endMeetingRoom` → broadcast `room:ended` → every client goes to recap. This works **while the WS socket is open**.
- `src/lib/websocket.ts` — the degradation sequence:
  - `maxReconnectAttempts = 5` (line 9); backoff 1s→2s→4s→8s→8s (~23s total). After the 5th failure, `scheduleReconnect()` returns and **reconnection stops forever** (line 74).
  - `send()` when the socket is not OPEN (lines 85-89):
    ```ts
    } else {
      // Queue for later
      this.pendingQueue.push(msg);
    }
    ```
    **Silently queues `room:end` forever** — no throw, no error surfaced, flushed only on a future `onopen` that never comes.
- So after a network blip / proxy idle-drop of the long-lived WS (which is exactly the "after a while" in a long meeting), the host's End click: (1) queues `room:end` into a dead queue, (2) fires the HTTP fallback → **always 400** → console error only. **The meeting never ends server-side: no `room:ended`, no recap, room stays `'active'`.**

---

## Status-code summary for `/end` (all paths)

| Code | Trigger | Reachable? |
|------|---------|-----------|
| 400 | Empty body + `Content-Type: application/json` (Fastify parser) | ✅ **OBSERVED — always, from this client** |
| 401 | Missing/invalid/expired room token (>24h meeting) | ✅ latent |
| 403 | Token/room mismatch; not host; participant purged by cleanup | ✅ latent |
| 404 | (only if a proxy returns it for missing route) | not produced by handler |
| 500 | `endMeetingRoom` throws (DB down / engine bug) | ✅ latent |
| 200 | Success — also on repeat/double end (idempotent) | ✅ |

---

## TOP SUSPECT (root cause)

**`src/lib/api.ts` `request()` hardcodes `'Content-Type': 'application/json'` (line 90) and `endRoom()` POSTs with no body (lines 183-187) → Fastify 5 rejects the empty JSON body with `FST_ERR_CTP_EMPTY_JSON_BODY` → 400 before the route handler runs.** The HTTP end fallback is permanently broken; it becomes user-visible only after the WS dies mid-meeting (5-attempt reconnect exhaustion + silent `pendingQueue` buffering), which is why the failure appears to "creep in after a while."

## Recommended fix

1. **Primary (client, 1-line-ish):** in `src/lib/api.ts` `request()`, only set `Content-Type: application/json` when a body exists:
   ```ts
   const hasBody = opts?.body != null;
   headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...(opts?.headers ?? {}) },
   ```
   — or, minimally, give `endRoom` a body: `body: JSON.stringify({})`.
2. **Robustness (client):** in `src/lib/websocket.ts` `send()`, do NOT silently buffer control messages like `room:end` forever — after reconnect exhaustion, throw/emit an error so the UI can surface "connection lost — cannot end meeting," and clear `pendingQueue` when reconnects give up.
3. **Optional server hardening:** keep `/end` idempotent (already is); optionally return `200 {ok:true}` for already-ended rooms explicitly.
4. **Latent (long meetings >24h, separate bugs):** JWT TTL is 24h (`jwt.ts:28`) — all authed endpoints 401 after that; and cleanup's activity watermark uses `joined_at`, not last-seen (`pgQueries.ts:393` / `memory.ts:296-298`) — add a last-seen/heartbeat field so active rooms can't be purged mid-meeting.
