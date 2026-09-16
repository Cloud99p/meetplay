# Postgres in production (Supabase) — setup, migrations, backups

MeetPlay runs with an in-memory store by default (`USE_MEMORY_DB=1`) and
switches to **real Postgres** as soon as `DATABASE_URL` is set. This document
covers standing that up: **project → connection string → env vars →
migrations → backups → restore drill**.

> **Status: verified against the live project on 2026-09-16.** Production
> project ref `efaieghpikezxudvpdmh` (PostgreSQL **17.6**, region
> **eu-west-2**). Migrations applied, 7 tables + 15 indexes live, all 36
> `verify-postgres.mjs` checks pass, and a backup was dumped and restored.

---

## 1. Which database? A separate Supabase project ✅

Use a **new, dedicated Supabase project for MeetPlay** — not a new database
inside an existing project, and not a shared schema.

| Option | Verdict | Why |
|---|---|---|
| **New project, dedicated to MeetPlay** | ✅ recommended | Own credentials, connection limits, backup schedule, restore point. A leaked key or runaway query can't touch your other work. Free tier allows 2 active projects. |
| Extra database in an existing project | ❌ | Supabase exposes `postgres` (+ `_shadow`); you'd share one role/credential/connection budget and one backup timeline across unrelated apps. |
| Schema prefix in an existing database | ❌ worst | Routes and migrations assume `public`; one bad `DROP SCHEMA` takes everything down; backups can't be restored independently. |

Free-tier limits that matter for the pilot: **500 MB**, 60 connections,
**no automated backups** (§5). A 45-minute 6-person transcript is tens of KB, so
500 MB is not a real constraint for 5 centres.

---

## 2. Connection string — use the SESSION POOLER

The dashboard's headline "Direct connection" (`db.<ref>.supabase.co`) **does not
work on the free tier from most networks**: it resolves to an **IPv6-only**
address.

```
db.efaieghpikezxudvpdmh.supabase.co   A     → (none)
db.efaieghpikezxudvpdmh.supabase.co   AAAA  → 2a05:d01c:1b7:9302:cdad:ed9:b2e5:1a35
```

IPv6 reachability on the dev machine used for setup: **`ENETUNREACH`**. Railway
is IPv4-only for egress too, so the direct host would have failed in production
even if it worked locally. **Use the session pooler** (IPv4, Supavisor):

| | Value |
|---|---|
| Host | `aws-0-eu-west-2.pooler.supabase.com` |
| Port | `5432` (**session**, not the `6543` transaction pooler) |
| User | `postgres.efaieghpikezxudvpdmh` (role **plus** project ref) |
| Database | `postgres` |

```
postgresql://postgres.efaieghpikezxudvpdmh:<password>@aws-0-eu-west-2.pooler.supabase.com:5432/postgres
```

Notes:
- **Session pooler, not transaction pooler.** Port `6543` multiplexes and does
  not support session-level statements, so `pg_dump` and some migrations fail.
- **The pooler host is region-specific.** A wrong region answers
  `tenant/user <user> not found`; the right one reaches auth. That's how this
  project's region was determined (33 of 34 candidate regions said "not found").
- Find your own region in the dashboard: **Project Settings → Database →
  Connection string → Session pooler**.
- URL-encode the password (`@` → `%40`, `"` → `%22`).

Verify from any machine:

```bash
node --env-file=.env scripts/verify-postgres.mjs      # 36 checks
node --env-file=.env scripts/verify-db-security.mjs   # 24 checks (§4)
```

---

## 3. Env vars (Railway → Variables)

| Var | Value | Why |
|---|---|---|
| `DATABASE_URL` | session-pooler URI | turns on the Postgres backend |
| `USE_MEMORY_DB` | `0` | `1` forces in-memory even with a URL set |
| `JWT_SECRET` | `openssl rand -hex 32` | **required** — see the warning below |
| `DATABASE_SSL` | leave unset | TLS is automatic for non-localhost hosts (`require`/`verify`/`disable` to override) |
| `DATABASE_POOL_MAX` | `10` (default) | keep within the pooler's per-project limit |

> ⚠️ **A real `DATABASE_URL` without `JWT_SECRET` is a hard boot failure**, by
> design: the public dev fallback would let anyone forge host tokens. Set both
> in the same change.

---

## 4. Security: keep the app schema off the public Data API 🔒

Supabase grants `anon` / `authenticated` access to tables in `public` **by
default**, and the publishable key ships inside our client bundle. Before this
was fixed, the live project served the app tables to anyone with that key:

```
GET https://<ref>.supabase.co/rest/v1/transcript_events
    apikey: <publishable key>        →  HTTP 200  []
```

For a product holding **students' meeting transcripts**, that is a data breach
waiting for the first real session. The tables were empty at the time, so
nothing leaked.

The fix lives in the migrations (`migrate.ts` + `db/init.sql`) so every
environment gets it:

1. `ENABLE ROW LEVEL SECURITY` on all 7 app tables — RLS with **no policies**
   denies `anon`/`authenticated` by default.
2. `REVOKE ALL ... FROM anon, authenticated` + `ALTER DEFAULT PRIVILEGES
   ... REVOKE`, so tables added later are not born exposed.
3. Deliberately **not** `FORCE ROW LEVEL SECURITY` — that would apply the
   deny-all to the table owner (our server's role) and lock the app out of its
   own data. The owner bypass is what keeps the app working.

After the fix: `HTTP 401` (`42501`) on every table, and the app's own
read/write path still passes all 36 checks. Re-run the guard anytime:

```bash
node --env-file=.env scripts/verify-db-security.mjs
```

> If you ever *do* want client-side reads, add explicit RLS policies and grant
> only the needed columns — don't just re-grant the table.

---

## 5. Migrations — automatic, no psql step

`runMigrations()` runs at every server boot (`server/src/db/migrate.ts`):

1. **Bootstrap** — creates the base schema (`rooms`, `participants`,
   `chat_messages`, `transcript_events`, `game_rounds`, `game_submissions`) and
   its indexes, all `IF NOT EXISTS`.
2. **Incremental changes** — `ALTER TABLE ... IF NOT EXISTS`,
   `CREATE TABLE IF NOT EXISTS`, guarded constraint fixes, and the RLS lockdown.

Every statement is idempotent, so **pointing `DATABASE_URL` at an empty
database and starting the server is the whole deployment step**. `db/init.sql`
remains for local docker-compose but is no longer needed in production — that
was a real gap: docker-compose mounts it, managed databases never do.

### Schema history worth knowing

| Date | Change | Why it mattered |
|---|---|---|
| 2026-09-16 | `room_recordings` table | recap playback after the room is deleted |
| 2026-09-16 | **`ON DELETE CASCADE` on `chat_messages`, `transcript_events`, `game_submissions` → `participants`** | These FKs had no delete rule, so deleting a room (the 24h privacy purge) aborted with an FK violation and **never purged anything**. Host-remove of a participant failed silently too. |
| 2026-09-16 | **RLS + revokes on all app tables** | app tables were readable via the public Data API (see §4) |

### Manual apply — `db/supabase-setup.sql`

`db/supabase-setup.sql` is the whole schema as one paste-and-run script
(Supabase dashboard → SQL Editor → Run). It is **idempotent**: safe on a new
project and a no-op on the existing one, so it doubles as the rebuild path and
as documentation of what the app expects. Order inside the file matters
(tables → indexes → security) — run it whole, don't cherry-pick.

Verify a database matches another one (e.g. after a paste, or prod vs staging):

```bash
node --env-file=.env scripts/schema-fingerprint.mjs > a.txt   # or npm run db:fingerprint
# ...same with the other DATABASE_URL...
diff a.txt b.txt
```

The fingerprint covers tables, RLS flags, columns/defaults, constraints incl.
`ON DELETE` behaviour, indexes and Data-API grants. Verified 2026-09-16: a fresh
`postgres:17` database with `supabase-setup.sql` applied is **structurally
identical to the live Supabase project**, and the full 36-check
`verify-postgres.mjs` suite passes on top of it.

### Which store is the app using? (dev vs prod)

The server picks its store from env only (`server/src/index.ts`):

| Env | Store | Data survives a restart? |
|---|---|---|
| `DATABASE_URL` set, `USE_MEMORY_DB` unset/`0` | **Postgres** | ✅ yes |
| `USE_MEMORY_DB=1`, or no `DATABASE_URL` | in-memory | ❌ resets every boot |

`npm run dev` follows `.env`: it used to hard-force `USE_MEMORY_DB=1` (so local
dev silently threw data away on every restart). It now honours an explicit
`USE_MEMORY_DB` and otherwise prefers Postgres whenever `DATABASE_URL` exists —
so a `.env` with the Supabase session-pooler URI + `USE_MEMORY_DB=0` gives you
the **same data in the browser and in the app, across restarts**.

Quick checks (all read/write-safe, credentials never printed):

```bash
npm run db:status                                   # tables, RLS, row counts, newest rooms
npm run verify:persistence -- create                # create a room via the API + assert the row is in PG
npm run verify:persistence -- check <roomId>        # AFTER a restart: room is still there
npm run verify:persistence -- cleanup <roomId>      # delete the test room
```

⚠️ Running dev against Postgres with the default `JWT_SECRET` fallback is a bad
idea — set a real random `JWT_SECRET` in `.env`, because the dev server binds
to the LAN and a public fallback secret would let anyone forge host tokens.

### Account management (planned, not built)

Users/orgs/auth tables are deliberately **not** part of this schema yet. When
they land, just append them to `runMigrations()` — additive and idempotent by
construction — and they inherit the RLS lockdown automatically via
`ALTER DEFAULT PRIVILEGES` (see §4).

---

## 6. Backups

| Option | Cost | Retention | Notes |
|---|---|---|---|
| **GitHub Actions nightly dump** (`.github/workflows/db-backup.yml`) | free | 30 days (artifact) / longer in R2 | Set the `DATABASE_URL` repo secret; optional `S3_*` secrets for off-site copies. |
| **Supabase Pro backups** | $25/mo | 7 days daily + PITR add-on | Zero effort, point-in-time recovery. Right choice once the pilot has real users. |
| **Local/manual `node scripts/db-backup.mjs`** | free | your disk | Before risky changes. |

### Gotchas the backup path has already hit

- **Client/server version parity.** `pg_dump` refuses to dump a *newer* server
  ("server version mismatch"). Supabase is PG **17**, so both the script and the
  workflow use 17 — a 16 client failed immediately.
- **App schema only.** `--schema=public`. A full-database dump included
  Supabase's own `auth.*` tables (48 CREATE TABLEs vs our 7) and references
  provider-only roles, making it un-restorable on a plain Postgres.
- **Docker DNS.** `docker run` sometimes can't resolve pooler hostnames even
  when the host can: "Temporary failure in name resolution". The Docker
  fallback passes `--dns 1.1.1.1 --dns 8.8.8.8`.

```bash
DATABASE_URL="postgresql://..." node scripts/db-backup.mjs   # or --env-file=.env
```

Retention keeps the newest 14 dumps (`BACKUP_KEEP`).

### Restore drill — done, and across environments

> **A backup you have never restored is not a backup.**

Verified 2026-09-16: dumped the **live Supabase** database, restored it into a
**fresh local Postgres**, and compared — perfect match:

| | Live Supabase | Restored |
|---|---|---|
| Tables (public) | 7 | 7 |
| Indexes | 15 | 15 |
| Supabase internals in dump | — | 0 |

```bash
gunzip -c backups/meetplay-<stamp>.sql.gz | psql "$RESTORE_URL"
psql "$RESTORE_URL" -c "\dt"                  # expect the 7 app tables
```

Repeat after any schema change and before the pilot starts.

### Data retention (already implemented)

`cleanup.ts` purges rooms idle for >24h (`ROOM_RETENTION_HOURS`) hourly — which
is why the cascade fix mattered, and what honours the "transcription is scoped
to the meeting" promise. **Backups contain transcript text**, so keep the backup
bucket private and never back up to a public bucket.
