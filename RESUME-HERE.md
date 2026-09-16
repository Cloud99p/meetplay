# RESUME HERE — MeetPlay

**State as of 2026-09-16 (evening WAT): the app is live, persistent and the core
loop works.** Captions and call recording are both confirmed working in
production. Nothing is on fire; the list at the bottom is improvements, not
firefighting.

Local path: `C:\Users\jpout\.openclaw\workspace\meetplay` · GitHub:
`Cloud99p/meetplay` (`main`) · Prod: `https://meetplay-production.up.railway.app`
· DB: Supabase `meetplay-prod` (`efaieghpikezxudvpdmh`)

---

## 1. What is live and verified

| Piece | State | How it was verified |
|---|---|---|
| Supabase schema (7 tables, 15 indexes, RLS on, no anon grants) | ✅ | `npm run db:status`, `npm run db:fingerprint` |
| Railway prod → Supabase (data survives restarts/redeploys) | ✅ | room created on the live URL, row read back from Postgres |
| Captions end to end (broadcast + attribution + `transcript_events` row) | ✅ | `npm run verify:caption` + live prod probe |
| Recording: config + egress acceptance | ✅ | `npm run verify:recording-live <base>` |
| Recording: playback in browser | ✅ | confirmed by Cloud after setting `S3_BUCKET` |
| R2 bucket + pre-signed playback URLs | ✅ | `npm run verify:r2`, `npm run verify:presign` |

## 2. How to run the checks

```bash
cd meetplay
npm run verify:caption                 # WS + Postgres: synthetic speaker ids, transcript rows
npm run verify:stt                     # live Deepgram, ~36s (must exceed the 30s keepalive window)
npm run verify:recording              # egress payload shape (offline)
npm run verify:presign                # 24 offline checks on signed playback URLs
npm run verify:r2                     # live bucket round trip (needs S3_* in .env)
npm run verify:recording-live <base>  # deployed app: config + egress acceptance
npm run db:status                     # tables, RLS, row counts, newest rooms
npm run verify:persistence -- create  # create/check/cleanup a room against a DB
```

## 3. Gotchas that cost time — read before debugging

1. **Supabase host**: `db.<ref>.supabase.co` is IPv6-only on the free tier and
   Railway is IPv4-only → `ENETUNREACH`. Always the **session pooler**
   (`aws-0-eu-west-2.pooler.supabase.com:5432`, user `postgres.<ref>`). The
   password contains `@` and `"` → percent-encode (`%40…%22`).
2. **A `DATABASE_URL` disables the memory fallback**: the server retries 5×, then
   boots with every query failing. There is no "works but forgets" middle ground.
3. **`S3_BUCKET` is the one variable with no default and no alias.** The
   credentials accept Cloudflare's UI labels (`Access_Key_ID` /
   `Secret_Access_Key`); the endpoint must NOT include `/meetplay`.
   The bucket stays **private** — playback is a signed URL, never `pub-*.r2.dev`.
4. **Dev vs prod divergence**: the in-memory store accepts anything, Postgres
   validates. Two of today's three bugs were exactly this. Any client-supplied
   value that becomes a query parameter needs a shape guard.
5. **Any `/ws` message sent immediately after connect** now gets queued — don't
   re-introduce work before the listener is attached.
6. **Deepgram Flux (`flux-general-en`) is v2**: no `KeepAlive`, no v1 params. Use
   `nova-2` via `DEEPGRAM_MODEL` if you need v1 behaviour.
7. **Test/probe scripts must end rooms via `POST /api/rooms/:id/end` before
   deleting rows**, or the deployed server keeps an in-memory game engine and
   spams `game_rounds_room_id_fkey` errors.
8. This machine's clock runs ~1–2 min ahead → short-lived signed URLs look
   expired locally; use ≥300s in tests. Production signs with a synced clock.
9. `npm run dev` now follows `.env`, and `.env` points at the **prod** database.
   Set `USE_MEMORY_DB=1` locally unless you mean to touch production data.
10. Docker image is `node:20`; the AWS SDK warns it will need ≥22 from Jan 2027.

## 4. Open items (nothing urgent)

| Item | Who | Notes |
|---|---|---|
| GitHub Actions backup secret `DATABASE_URL` | Cloud | nightly dump skips itself while unset; Supabase free has no backups |
| Rotate Supabase DB password + R2 token | Cloud | both appeared in chat; after rotating, update Railway + local `.env` |
| Retention: app purges rooms idle >24h (`ROOM_RETENTION_HOURS`), R2 lifecycle deletes after 30d | decide | 24h is privacy-first; a 30-day pilot may want longer |
| Point local `.env` at a dev project (or set `USE_MEMORY_DB=1`) | Cloud | otherwise dev writes to pilot data |
| `/health` to report DB reachability + fail fast on migration failure | me | recommended after the prod incident with the wrong host |
| Dockerfile `node:20` → `node:22` | me | removes the AWS SDK warning |
| Per-room `recording_mode` (audio vs video) | later | businesses will want video; currently a global env flag |
| **Account management** (users/orgs/auth) | next feature | deliberately parked. Add tables via `runMigrations()` — additive/idempotent — and they inherit the RLS lockdown via `ALTER DEFAULT PRIVILEGES` |

## 5. Where the machinery lives

- Schema: `server/src/db/migrate.ts` (auto-runs at boot) and
  `db/supabase-setup.sql` (paste-and-run, idempotent, for new projects).
- Recording: `server/src/livekit/recording.ts` + `server/src/storage/presign.ts`
  (`docs/RECORDING.md`).
- Captions: `server/src/routes/stt.ts` (Deepgram proxy) + the caption handler in
  `server/src/ws/handler.ts` (`docs/STT.md`).
- Postgres specifics, RLS and backups: `docs/POSTGRES.md`.
