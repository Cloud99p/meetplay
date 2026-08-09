# MeetPlay — Video Meetings with Real-Time Attention Games

A video-conferencing web app that turns the live
transcript into opt-in mini-games — **Who Said That?**, **Meeting Scrabble**,
**Word Count Bet**, **Flash WCB**, **Member Word Bets**, and **Buzzword Bingo** —
so people have a genuine reason to listen. Games live in a collapsible side
panel, are time-boxed, and never block the video.

> **Design constraint held throughout**: every game is a natural byproduct of
> paying attention, never a distraction. If a feature risks pulling focus from
> the conversation, it's cut or redesigned (see Quiet mode below).

**Live demo**: <https://meetplay-production.up.railway.app> (auto-deployed from `main`)

---

## Features

- **Live captions** — streaming speech-to-text with per-turn confidence scoring;
  low-confidence captions are dimmed in the overlay and filtered from games/recap.
- **Six attention games generated from the transcript** (opt-in per meeting):
  - **Who Said That?** — quote from the meeting, guess the speaker
  - **Meeting Scrabble** (Letter Tiles) — spell real meeting words from scrambled tiles
  - **Word Count Bet** — bet on how many times a word gets said
  - **Flash WCB** — quick-fire automatic bets (the only auto-starting game)
  - **Member Word Bets** — anyone can open a bet mid-meeting
  - **Buzzword Bingo** — mark your card as buzzwords get said
- **Meeting Intelligence recap** (Omnilearn graph) — recap quiz, leaderboard,
  speaker stats, full searchable transcript with **one-click download**.
- **Privacy first** — transcription is opt-in per meeting with a consent banner;
  transcripts are deleted when the meeting ends; rooms are private by default.
- **Degrades gracefully** — if media is unavailable the meeting continues in
  text mode (chat + games + captions still work).

---

## Quick start (zero config, no API keys)

```bash
npm install
npm run dev        # starts backend :3001 + Vite :5173 (+ auto-installs local LiveKit on Linux)
```

Open http://localhost:5173 in **two browser tabs**:

1. Tab A → **Create Room** → you're the host.
2. Tab B → paste the invite link (**Invite** button, top-right of the meeting) → join.
3. Host clicks **"Enable captions & games"** → consent banner → mock captions stream →
   the first game round auto-starts after ~8 utterances (~30s of talking).
4. Play the rounds; check the **Games** panel and **leaderboard**; end the meeting →
   **Recap page** shows transcript, game winners, leaderboard, key quotes.

No paid APIs required. The **MockAdapter** generates a deterministic conversation
script that deliberately exercises all the games.

### One-command deploy (Docker)

```bash
docker compose up --build     # Postgres + LiveKit + server + web
# or for the single-container production image:
docker build -t meetplay . && docker run -p 5173:5173 meetplay
```

---

## Run modes

| Mode | Backend | Media | Transcription | How |
|---|---|---|---|---|
| **Local dev (default)** | in-memory DB | local LiveKit (Linux) or LiveKit Cloud | Mock STT | `npm run dev` |
| **Docker compose** | Postgres | LiveKit container | Mock STT | `docker compose up` |
| **Production (Railway/etc.)** | in-memory or Postgres | LiveKit Cloud (env vars) | Mock/WebSpeech/Deepgram | deploy `Dockerfile` — see [DEPLOY.md](DEPLOY.md) |

### Speech-to-text modes (`VITE_STT_MODE`)

STT is adapter-based behind a single `STTAdapter` contract — every adapter emits
`{ speakerId, text, isFinal, timestamp }`, so the games engine and captions
overlay work identically in every mode. Select the backend at build time with an
env var (see [`.env.example`](.env.example)):

| Mode | Adapter | Diarization | Needs key | Use when |
|---|---|---|---|---|
| `mock` (default) | `MockAdapter` | ✅ synthetic | ❌ | Demos / zero-config local dev |
| `webspeech` | `WebSpeechAdapter` | ❌ (single `local` speaker) | ❌ | Free browser-native STT — captions only; "Who Said That?" degrades (no speakers) |
| `deepgram` | `DeepgramAdapter` | ✅ real (per-word speaker) | `DEEPGRAM_API_KEY` (server-side) | **Production** — streaming + diarized via server proxy, powers all games correctly |

```bash
# Production: real diarized STT (key stays on the server — no client key needed)
VITE_STT_MODE=deepgram npm run build   # + set DEEPGRAM_API_KEY on the server

# Or free browser STT (no diarization)
VITE_STT_MODE=webspeech npm run dev

# Or zero-config demo (default)
npm run dev
```

Deepgram mode uses a **server-side proxy** (`/api/stt`): the browser streams
mic audio to your own server, which forwards it to Deepgram with the key in an
`Authorization` header. **The key never ships to the browser bundle.** The proxy
is model-aware via `DEEPGRAM_MODEL`: `nova-2` (v1, diarized multi-speaker — needed
for Who Said That? and bingo) or `flux-general-en` (v2, turn-based, ultra-low
latency, no diarization).

**Mock STT is the default dev mode by design** — the whole app runs free and
locally without keys.

---

## Meeting Intelligence (Omnilearn)

When `OMNILEARN_ENABLED=1` (default), the server records each utterance into the
Omnilearn knowledge graph (`server/src/intelligence/omniClient.ts` — batched,
idempotent, fire-and-forget) and reads it back for "Who Said That?" quotes and
the recap quiz. If Omnilearn is unreachable the app falls back to the in-memory
buffer — games and recap keep working. See [INTEGRATION.md](INTEGRATION.md).

---

## Test suite (all pass)

```bash
node scripts/ws-test.mjs 3001            # room lifecycle + chat + emoji over WS (6/6)
node scripts/caption-test.mjs 3001       # transcript toggle → caption broadcast (3/3)
node scripts/game-loop-test.mjs 3001     # captions → round open → lock → score (5/5)
node scripts/games-client-test.mjs       # client game libs unit tests (15/15)
node scripts/identity-test.mjs 3001      # unique names, 409, same-user rejoin (4/4)
node scripts/recap-test.mjs 3001         # recap: transcript, rounds, leaderboard (8/8)
node scripts/security-fixes-test.mjs     # auth 401/403/200 matrix, lockout, CORS (16/16)
node scripts/verify-speaker-mapping.mjs  # STT speaker → participant mapping (6/6)
node scripts/verify-livekit-token.mjs    # LiveKit Cloud token signature check
```

(Start the server first: `PORT=3001 USE_MEMORY_DB=1 node server/dist/index.js`
after `cd server && npx tsc -p tsconfig.json`.)

Typechecks: `npx tsc --noEmit -p tsconfig.json` (client) and same in `server/`.

---

## Security & privacy

- **No secrets in the repo.** All configuration is via environment variables;
  `.env` is gitignored and only `.env.example` is tracked. The server refuses to
  boot in production without a `JWT_SECRET` (no fallback keys, no committed creds).
- Room tokens are required for recap/messages; password-protected rooms with
  per-room + IP lockout (5 fails → 15-min block); rate-limited APIs; CORS
  restricted to configured `CLIENT_ORIGINS`.
- Abandoned rooms and transcripts are purged after 24h idle (`cleanup.ts`).
- Transcription is **opt-in per meeting** (host toggle) with a per-client consent
  banner; transcripts are deleted when the meeting ends. Full details in
  [ARCHITECTURE.md](ARCHITECTURE.md) §5.

---

## Deploy

**Railway-ready** — `railway.json` + single-container `Dockerfile`, health check
`/health`, port 5173 or injected `PORT`. Deployment is driven entirely by env
vars — no committed secrets, no fallback credentials. Full walkthrough for
Railway / Render / Fly.io / any VPS: **[DEPLOY.md](DEPLOY.md)**.

---

## Architecture

See **[ARCHITECTURE.md](ARCHITECTURE.md)** — component boundaries, data flow
(spoken word → transcript event → game state → render), failure modes, LiveKit
rationale, security model, and the build-order evidence trail.

---

## Key decisions (full reasoning in ARCHITECTURE.md §4)

1. **LiveKit over Daily/Agora** — open-source SFU, self-hostable + Cloud option,
   React components included. Tradeoff: a second service; the app degrades to
   text mode if it's down.
2. **WebSockets for game events, not LiveKit data channel** — one transport for
   chat + captions + games; SFU stays media-only; works even if LiveKit is down.
3. **No Redis at MVP** — in-process game state fits 20–50 users/room on one node;
   Postgres persists rounds/scores. Redis is the horizontal-scaling step.
4. **Flat repo, not apps/packages monorepo** — single app; client/server split
   already enforces boundaries. Restructuring adds tooling, not function.
5. **Guest identity, not Clerk/Auth.js** — guests join without accounts
   (persistent localStorage userId + server-enforced unique names per room,
   409 on duplicate, same-user rejoin allowed). Team/SSO is stretch.
6. **Who Said That? quality threshold** — a quote qualifies only if ≥10 words,
   no timestamp overlap with another speaker, ≥3 non-stopword content words;
   otherwise the engine skips to the next game type rather than asking a bad question.
7. **Meeting Scrabble dictionary** — the word bank *is* the dictionary (words
   spoken in the meeting, deduped, min 2 chars). Meeting-specific jargon is the
   point; there is no external dictionary to reject it.
8. **Word Count counting** — case-insensitive, stem-aware matching ('roadmapping'
   counts toward 'roadmap'); stopwords never false-positive (≥4-char guard).
9. **Late-joiner fairness** — no retroactive scoring on closed rounds; Word Count
   Bet late joiners get a **par bet** = floor(average of others' guesses).
   Leaderboard ranks by **pointsPerRound**, tiebreak total points.
10. **Quiet mode** — when anyone screen-shares (host presenting), the Games panel
    shows "quiet — presenting" and notifications suspend; round state still syncs
    so nobody loses their place.

---

## Mobile

Mobile gets full participation: LiveKit supports mobile WebRTC on modern
iOS/Android browsers, and the games panel is a side sheet that works on small
screens. The only difference: **screen share is hidden on touch devices**
(`getDisplayMedia` is desktop-only; the ControlBar detects touch). Everything
else — video, mic, chat, games, captions — works on mobile.

---

## Stretch (not yet built, in order)

Recording + playback · team/SSO accounts · engagement analytics · PWA · monetization tiers.
