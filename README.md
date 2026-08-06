# MeetPlay — Video Meetings with Real-Time Attention Games

A video-conferencing web app (Google Meet / Zoom alternative) that turns the live
transcript into opt-in mini-games — **Who Said That?**, **Meeting Scrabble**, and
**Word Count Bet** — so people have a genuine reason to listen. Games live in a
collapsible side panel, are time-boxed, and never block the video.

> **Design constraint held throughout**: every game is a natural byproduct of
> paying attention, never a distraction. If a feature risks pulling focus from
> the conversation, it's cut or redesigned (see Quiet mode below).

---

## Quick start (zero config, no API keys)

```bash
npm install
npm run dev        # starts backend :3001 + Vite :5173 (+ auto-installs local LiveKit on Linux)
```

Open http://localhost:5173 in **two browser tabs**:
1. Tab A → **Create Room** → you're the host.
2. Tab B → paste the invite link (🔗 Invite button, top-right of the meeting) → join.
3. Host clicks **"Enable captions & games"** → consent banner → mock captions stream →
   the first game round auto-starts after ~8 utterances (~30s of talking).
4. Play the rounds; check the **Games** panel and **leaderboard**; end the meeting
   → **Recap page** shows transcript, game winners, leaderboard, key quotes.

No paid APIs required. The **MockAdapter** generates a deterministic conversation
script that deliberately exercises all three games.

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
| **Production (Railway/etc.)** | in-memory or Postgres | LiveKit Cloud (env vars) | Mock/WebSpeech/Deepgram | deploy `Dockerfile` |

### Speech-to-text modes (`VITE_STT_MODE`)

STT is adapter-based behind a single `STTAdapter` contract — every adapter emits
`{ speakerId, text, isFinal, timestamp }`, so the games engine and captions
overlay work identically in every mode. Select the backend at build time with an
env var (see `.env.example`):

| Mode | Adapter | Diarization | Needs key | Use when |
|---|---|---|---|---|
| `mock` (default) | `MockAdapter` | ✅ synthetic | ❌ | Buildathon/demo, zero-config local dev |
| `webspeech` | `WebSpeechAdapter` | ❌ (single `local` speaker) | ❌ | Free browser-native STT — captions only; "Who Said That?" degrades (no speakers) |
| `deepgram` | `DeepgramAdapter` | ✅ real (per-word speaker) | `DEEPGRAM_API_KEY` (server-side) | **Production** — streaming + diarized via server proxy, powers all 3 games correctly |

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
Authorization header. The key never ships to the browser bundle.

**Mock STT is the default dev mode by design** — the whole app runs free and
locally without keys.

---

## Test suite (all pass)

```bash
node scripts/ws-test.mjs 3001          # room lifecycle + chat + emoji over WS (6/6)
node scripts/caption-test.mjs 3001     # transcript toggle → caption broadcast (3/3)
node scripts/game-loop-test.mjs 3001   # captions → round open → lock → score (5/5)
node scripts/games-client-test.mjs     # client game libs unit tests (15/15)
node scripts/identity-test.mjs 3001    # unique names, 409, same-user rejoin (4/4)
node scripts/recap-test.mjs 3001       # recap: transcript, rounds, leaderboard (8/8)
node scripts/verify-livekit-token.mjs  # LiveKit Cloud token signature check
```

(Start the server first: `PORT=3001 USE_MEMORY_DB=1 node server/dist/index.js`
after `cd server && npx tsc -p tsconfig.json`.)

Typechecks: `npx tsc --noEmit -p tsconfig.json` (client) and same in `server/`.

---

## Mobile decision (explicit)

**Mobile gets full participation.** Rationale: LiveKit supports mobile WebRTC on
modern iOS/Android browsers, and the games panel is a side sheet that works on
small screens. The only difference: **screen share is hidden on touch devices**
(`getDisplayMedia` is desktop-only; the ControlBar detects touch). Everything else
— video, mic, chat, games, captions — works on mobile. We chose full participation
over read-only because the games are the differentiator and locking them out of
phones would gut the product for a large share of meeting participants.

---

## Key decisions & interpretations (stated explicitly, per the prompt)

1. **LiveKit over Daily/Agora** — open-source SFU, self-hostable + Cloud option,
   React components included. Tradeoff: it's a second service; the app degrades to
   text mode if it's down. (Full reasoning in ARCHITECTURE.md §4.)
2. **WebSockets for game events, not LiveKit data channel** — one transport for
   chat+captions+games; SFU stays media-only; works even if LiveKit is down.
3. **No Redis at MVP** — in-process game state fits 20–50 users/room on one node;
   Postgres persists rounds/scores. Redis is the horizontal-scaling step.
4. **Flat repo, not apps/packages monorepo** — single app; client/server split
   already enforces boundaries. Restructuring adds tooling, not function, at this
   size.
5. **Guest identity, not Clerk/Auth.js** — prompt requires guests join without
   accounts. We use a persistent localStorage userId + **unique display names per
   room** (server-enforced, 409 on duplicate, same-user rejoin allowed). Team/SSO
   is explicitly a stretch goal.
6. **Who Said That quality threshold** — a quote qualifies only if: ≥10 words,
   no timestamp overlap with another speaker, ≥3 non-stopword content words.
   If no quote passes, the engine skips to the next game type rather than asking
   a bad question.
7. **Scrabble dictionary** — the word bank *is* the dictionary (words spoken in the
   meeting, deduped, min 2 chars). Proper nouns/jargon are naturally included —
   that's the point of a meeting-specific game; there is no external dictionary to
   reject them.
8. **Word Count counting** — case-insensitive **substring** match
   ('roadmapping' counts toward 'roadmap'); plural forms count because the singular
   is a substring. Documented in `countOccurrences`.
9. **Late-joiner fairness** — no retroactive scoring on closed rounds; Word Count
   Bet late joiners get a **par bet** = floor(average of others' guesses).
   Leaderboard ranks by **pointsPerRound**, tiebreak total points.
10. **Quiet mode** — when anyone screen-shares (host presenting), the Games panel
    shows "quiet — presenting" and notifications suspend; round state still syncs
    so nobody loses their place.

---

## Privacy (hard requirement)

- Transcription is **opt-in per meeting** (host toggle) + per-client consent banner.
- Transcript events are only persisted while enabled; deleted with the room on end.
- Recap respects consent: it reads only persisted events, never synthesizes.
- Rate-limited APIs; rooms private by default; optional password.

---

## Architecture

See **[ARCHITECTURE.md](ARCHITECTURE.md)** — component boundaries, data flow
(spoken word → transcript event → game state → render), failure modes, LiveKit
rationale, and the build-order evidence trail.

---

## Deploy

Public repo: https://github.com/Cloud99p/meetplay · **Railway-ready**
(`railway.json` + single-container `Dockerfile`, health check `/health`, port 5173
or injected `PORT`). LiveKit Cloud URL/key/secret are committed fallbacks so deploys
work with zero env vars — **rotate the LiveKit Cloud API secret after the buildathon**
(it's intentionally visible for zero-config deploys).

## Stretch (not yet built, in order)
Recording + playback · team/SSO accounts · engagement analytics · PWA · monetization tiers.
