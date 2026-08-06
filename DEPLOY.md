# DEPLOY.md — Deploy MeetPlay to production

The app is a **single-container** deployment: the Fastify backend serves the
built frontend (SPA fallback) + REST API + WebSocket, all on **one port**.
The browser only talks to one origin — no CORS, no WebSocket edge problems.

**All configuration is via environment variables.** There are no committed
secrets in the repo. Set them in your platform's dashboard (see table below).

## Deploy to Railway (recommended — free, WebSocket-friendly)

This repo includes `railway.json` (Dockerfile builder, `/health` probe).

1. Push this repo to GitHub (already at github.com/Cloud99p/meetplay).
2. Railway → **New Project** → **Deploy from GitHub repo** → pick `Cloud99p/meetplay`.
3. Railway auto-detects `railway.json` + `Dockerfile` (single container).
4. **Add the required env vars** (below) in Railway → Variables. Railway
   injects build-time vars (`VITE_*`) into the Docker build automatically, and
   runtime vars (`LIVEKIT_*`, `JWT_SECRET`, `DATABASE_URL`) into the container.
5. Railway health-checks `/health` and gives you a public URL. Done.

## Required env vars (no app runs without LiveKit)

| Var | Example | Purpose |
|-----|---------|---------|
| `LIVEKIT_URL` | `wss://meetplay-xxx.livekit.cloud` | LiveKit Cloud (or local) server URL |
| `LIVEKIT_API_KEY` | `API...` | LiveKit Cloud API key (cloud.livekit.io → Settings) |
| `LIVEKIT_API_SECRET` | (64-char secret) | LiveKit Cloud API secret — **rotate it now if you ever committed it** |

## Optional env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `JWT_SECRET` | `meetplay-dev-secret` | Room token signing — **set a long random string in prod** (`openssl rand -hex 32`) |
| `DATABASE_URL` | (none → in-memory) | Postgres connection string for persistence; set `USE_MEMORY_DB=0` |
| `USE_MEMORY_DB` | `1` | In-memory DB (data resets on restart) |
| `RATE_LIMIT_MAX` | `120` | API rate limit per IP per minute |
| `PORT` | `3001` | Server port (Railway injects it automatically) |
| `DEEPGRAM_API_KEY` | — | Deepgram key (server-side /api/stt proxy) — required when `VITE_STT_MODE=deepgram` |
| `DEEPGRAM_MODEL` | `nova-2` | `nova-2` (v1, diarized multi-speaker — needed for games) or `flux-general-en` (v2, turn-based, no diarization) |
| `VITE_STT_MODE` | `mock` | `mock` \| `webspeech` \| `deepgram` (baked at build time) |
| `VITE_LIVEKIT_URL` | — | Client-side LiveKit URL override (baked at build time) |
| `VITE_SERVER_URL` | `''` (same-origin) | Override API/WS base URL |

> ⚠️ **VITE_* vars are baked into the frontend at build time** — changing them
> requires a redeploy. **Server vars (LIVEKIT_*, JWT_SECRET, DATABASE_URL) are
> read at runtime** — changing them just needs a restart.

## Deploy to Render / Fly.io / any VPS

- Render: Blueprint or Docker service → same Dockerfile → set env vars above.
- Fly.io: `fly launch` with this Dockerfile → `fly secrets set LIVEKIT_URL=... ...` → `fly deploy`.
- VPS: `docker build -t meetplay . && docker run -p 3001:3001 --env-file .env meetplay`.

## Local dev

1. `cp .env.example .env` and fill in `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (from cloud.livekit.io).
2. `npm run dev` — backend :3001 + Vite :5173, mock STT by default.
3. For real STT: set `VITE_STT_MODE=deepgram` and `VITE_DEEPGRAM_API_KEY` (console.deepgram.com).

## Demo checklist for judges

1. Open the deployed URL in two browser tabs.
2. Tab A: create room → **Host**; Tab B: join by link.
3. Host clicks **CC** → captions appear → Games panel fills in ~15s.
4. Play "Who Said That?", Scrabble, Word Count Bet; leaderboard updates live.
5. End meeting → recap page shows transcript + rounds.
