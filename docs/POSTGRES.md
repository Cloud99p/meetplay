# Postgres in production (Supabase) — setup, migrations, backups

MeetPlay runs with an in-memory store by default (`USE_MEMORY_DB=1`) and
switches to **real Postgres** as soon as `DATABASE_URL` is set. This document
covers standing that up for the pilot: **Supabase project → env vars →
migrations → backups → restore drill**.

---

## 1. Which database? Separate Supabase project ✅

Use a **new, dedicated Supabase project for MeetPlay** — not a new database
inside an existing project, and not a shared schema.

| Option | Verdict | Why |
|---|---|---|
| **New project, dedicated to MeetPlay** | ✅ recommended | Own credentials, own connection limits, own backup schedule, own restore point. A leaked key or a runaway query can't touch your other work. Free tier allows 2 active projects. |
| Extra database in an existing project | ❌ | Supabase exposes `postgres` (+ `_shadow`); you'd have to share one role/credential/connection budget and one backup timeline across unrelated apps. |
| Schema prefix in an existing database | ❌ worst | Migrations assume `public`; one bad `DROP SCHEMA` takes everything down; backups can't be restored independently. |

Free tier limits that matter for the pilot: **500 MB database**, 60 direct
connections, **no automated backups** (that's the part this doc solves).
Course data is small — transcript text for a 45-min, 6-person session is
tens of KB — so 500 MB is not a real constraint for 5 centres.

> One project per environment: `meetplay-prod` (pilot data). Add a separate
> `meetplay-staging` later rather than pointing staging at pilot data.

---

## 2. Create the project and get the connection string

1. Supabase dashboard → **New project** → name `meetplay-prod`, pick a region
   close to your Railway region, set a strong **database password** (save it in
   your password manager — it is not shown again).
2. Wait for provisioning (~2 min).
3. **Project Settings → Database → Connection string**. You need two forms:

| Use | Connection | Port | Notes |
|---|---|---|---|
| **App runtime** (Railway service) | **Session pooler** | `5432` | Long-lived server, few connections. Direct `db.<ref>.supabase.co` is IPv6-only on the free tier, so the pooler is the safe choice. |
| **Migrations / backups** | Session pooler or direct | `5432` | Do **not** use the transaction pooler (`6543`) for `pg_dump` — it doesn't support session-level statements. |

Copy the **session pooler** URI, which looks like:

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

URL-encode the password if it contains `@ : / ? # &`.

---

## 3. Env vars (Railway → Variables)

| Var | Value | Why |
|---|---|---|
| `DATABASE_URL` | the session-pooler URI above | turns on the Postgres backend |
| `USE_MEMORY_DB` | `0` | `1` forces the in-memory store even with a URL set |
| `DATABASE_SSL` | leave unset (defaults to TLS) | `require` = TLS, skip CA pinning; `verify` = full verification; `disable` = local only |
| `DATABASE_POOL_MAX` | `10` (default) | keep ≤ the pooler's per-project limit |

> ⚠️ **`DATABASE_URL` + a missing `JWT_SECRET` is a hard boot failure** by
> design (`isProductionMode()`), because the public dev fallback would let
> anyone forge host tokens. Set `JWT_SECRET` (`openssl rand -hex 32`) in the
> same change.

Setting `DATABASE_URL` makes data survive restarts: rooms, participants,
chat, transcripts, game rounds and **recordings** stop resetting on deploy.

---

## 4. Migrations — automatic, no psql step

`runMigrations()` runs at every server boot (`server/src/db/migrate.ts`):

1. **Bootstrap** — creates the base schema (`rooms`, `participants`,
   `chat_messages`, `transcript_events`, `game_rounds`, `game_submissions`)
   and the indexes, all `IF NOT EXISTS`.
2. **Incremental changes** — `ALTER TABLE ... IF NOT EXISTS`, `CREATE TABLE IF
   NOT EXISTS`, and guarded constraint fixes.

Every statement is idempotent, so pointing at an **empty** database and starting
the server is the whole deployment step. `app/init.sql` (see `db/init.sql`) is
kept for local docker-compose but is no longer required in production — that was
a real gap: docker-compose mounts it, managed databases never do.

Boot retries migrations 5× (3s apart) so a cold Supabase project or a brief
network blip doesn't kill the deploy.

### Verify the production database

```bash
DATABASE_URL="postgresql://...pooler.supabase.com:5432/postgres" \
  node scripts/verify-postgres.mjs
```

36 checks: bootstrap on an empty DB, idempotency, every table + index, a full
data round-trip (room → participant → transcript → round → submission →
recording), `getRecap()` including the recording, and cascade deletes.

### Schema history worth knowing

| Date | Change | Why it mattered |
|---|---|---|
| 2026-09-16 | `room_recordings` table | recap playback after the room is deleted |
| 2026-09-16 | **`ON DELETE CASCADE` on `chat_messages`, `transcript_events`, `game_submissions` → `participants`** | These FKs had no delete rule, so deleting a room (the 24h privacy purge) aborted with an FK violation and **never purged anything**. Host-remove of a participant failed silently too. |

---

## 5. Backups

| Option | Cost | Retention | Notes |
|---|---|---|---|
| **GitHub Actions nightly dump** (` .github/workflows/db-backup.yml`) | free | 30 days (artifact) / as long as you like in R2 | Works today, no card needed. Set the `DATABASE_URL` repo secret; optional `S3_*` secrets for off-site copies. |
| **Supabase Pro backups** | $25/mo | 7 days daily + PITR add-on | Zero effort, point-in-time recovery. The right choice once the pilot has real users. |
| **Local/manual `node scripts/db-backup.mjs`** | free | your disk | Before risky changes; uses local `pg_dump` or Docker. |

Run both free options rather than choosing: Actions for automation, manual for
before-migration insurance.

### Manual backup + restore drill

```bash
# Backup (writes backups/meetplay-<stamp>.sql.gz, keeps the newest 14)
DATABASE_URL="postgresql://..." node scripts/db-backup.mjs

# Restore into a scratch database and compare row counts
gunzip -c backups/meetplay-<stamp>.sql.gz | psql "$RESTORE_URL"
psql "$RESTORE_URL" -c "SELECT count(*) FROM rooms;"
```

**A backup you have never restored is not a backup.** The restore path above
was drilled on 2026-09-16 (source vs restored row counts matched for rooms,
participants, transcript_events and room_recordings). Repeat the drill after
any schema change and before the pilot starts.

### Data retention (already implemented)

`cleanup.ts` purges rooms idle for >24h (`ROOM_RETENTION_HOURS`) hourly, which
is why the cascade fix above mattered — and it's the mechanism that honours the
"transcription is scoped to the meeting" promise. Backups contain transcript
text, so treat the backup bucket as sensitive: keep it private, and don't back
up to a public bucket.
