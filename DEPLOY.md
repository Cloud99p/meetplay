# DEPLOY.md — Get MeetPlay working for the LabLab buildathon

The app is a **single-container** deployment: Vite dev server (:5173) proxies
`/api`, `/ws`, and `/rtc` to the in-container backend (:3001) and LiveKit (:7880).
The browser only talks to **one origin**, which avoids CORS and WebSocket edge
problems. The container auto-installs and starts LiveKit on first boot.

## Deploy to Railway (recommended — free, WebSocket-friendly, 1 click)

This repo already includes `railway.json` (Dockerfile builder, `/health` probe).

1. Push this repo to GitHub (it's already at github.com/Cloud99p/meetplay).
2. Railway → **New Project** → **Deploy from GitHub repo** → pick `Cloud99p/meetplay`.
3. Railway auto-detects `railway.json` + `Dockerfile` (single container).
4. **No env vars required** — LiveKit Cloud URL/key/secret are committed as
   fallbacks; in-memory DB is the default. Optional:
   - `DATABASE_URL` + `USE_MEMORY_DB=0` for Postgres persistence
5. Railway exposes port **5173** (from `EXPOSE`), health-checks `/health`, and
   gives you a public URL. Done.

> ⚠️ Rotate the LiveKit Cloud API secret in the LiveKit dashboard after the
> buildathon — the fallback key/secret is intentionally visible in the repo
> so previews/deployments work without `.env`.

## Deploy to Render / Fly.io / any VPS

- Render: Blueprint or Docker service → same Dockerfile → port 5173.
- Fly.io: `fly launch` with this Dockerfile → `fly deploy`, expose 5173.
- VPS: `docker build -t meetplay . && docker run -p 5173:5173 meetplay`.

## Env vars reference

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3001` (via `BACKEND_PORT`) | Backend port (internal) — decoupled from Railway's injected `PORT` |
| `USE_MEMORY_DB` | `1` | In-memory DB; set `0` + `DATABASE_URL` for Postgres |
| `DATABASE_URL` | — | Postgres connection string |
| `JWT_SECRET` | dev secret | Room token signing — **set a real one in prod** |
| `LIVEKIT_URL` | `wss://meetplay-3pba3wsu.livekit.cloud` | LiveKit server URL (cloud or local) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | committed fallbacks | Must match the LiveKit server keys |
| `VITE_SERVER_URL` | `''` (same-origin) | Override API/WS base URL (not needed single-container) |
| `VITE_LIVEKIT_URL` | — | Client-side LiveKit URL override (baked at build time) |

## Demo checklist for judges

1. Open the deployed URL in two browser tabs.
2. Tab A: create room → **Host**; Tab B: join by link.
3. Host clicks **CC** → captions appear → Games panel fills in ~15s.
4. Play "Who Said That?", Scrabble, Word Count Bet; leaderboard updates live.
5. End meeting → recap page shows transcript + rounds.