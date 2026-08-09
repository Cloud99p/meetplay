# MeetPlay — Architecture

**Status**: Implemented and verified. This document describes the system as built.

---

## 1. Component responsibilities and boundaries

```
┌───────────────────────────── Browser (React SPA) ─────────────────────────────┐
│                                                                               │
│  Lobby (create/join) ── MeetingRoom ── RecapPage                              │
│     │                        │                                                │
│     │ REST (/api)            │ WS (/ws) + LiveKit (media) + /api/stt (audio)  │
│     ▼                        ▼                                                │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │ Fastify API server (single container in prod)                        │    │
│  │  ├─ REST routes: rooms, join, transcript toggle, recap, livekit      │    │
│  │  ├─ WebSocket hub: chat, captions, game events, presence             │    │
│  │  ├─ RoomGameEngine: state machine, timers, scoring, leaderboard      │    │
│  │  ├─ /api/stt proxy: browser mic → Deepgram (key stays server-side)   │    │
│  │  ├─ Omnilearn client: meeting-intelligence graph (quotes, quiz)      │    │
│  │  ├─ Security: room tokens, password lockout, rate limits, cleanup    │    │
│  │  └─ DB layer: in-memory (dev default) or Postgres                    │    │
│  └───────────────────────────────┬──────────────────────────────────────┘    │
│                                  │                                            │
│                     ┌────────────┴────────────┐                              │
│                     │ LiveKit SFU (media)      │  (Cloud, or local via        │
│                     │ WebRTC: audio/video/     │   docker-compose)            │
│                     │ screen share             │                              │
│                     └─────────────────────────┘                              │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Boundaries**
- **Client** owns UI state and optimistic previews. It never decides scores.
- **API server** is the authority for rooms, participants, transcripts, games, and scores. All game scoring runs server-side.
- **LiveKit** handles only media transport (WebRTC). It has no knowledge of games.
- **DB layer** (`db/queries.ts` → `memory.ts` | `pgQueries.ts`) is the only place that touches storage; the engine and routes go through it.

---

## 2. Data flow: spoken word → game state → client render

```
participant speaks
   │  (mic audio via getUserMedia)
   ▼
STT adapter (MockAdapter default; WebSpeech / DeepgramAdapter behind same contract)
   │  Deepgram: browser streams PCM16 audio over WS → server /api/stt proxy →
   │            Deepgram Live API (v1 diarized nova-2, or v2 flux turn-based)
   │  utterance { speakerId, text, isFinal, timestamp, confidence }
   ▼
Client sends caption:event over WebSocket
   ▼
Server WS handler: [1] resolves real speaker (synthetic ids → participant),
                   [2] persists transcript event (consent-gated),
                   [3] broadcasts caption:event
   │
   ▼
RoomGameEngine.addUtterance()   ──also──►  Omnilearn client (record, fire-and-forget)
   │  buffer grows; if ≥8 utterances & cooldown passed & no active round:
   ▼
maybeStartRound() → builds round data per game type:
   ├─ Who Said That:   quality-gated quote (≥10 words, ≥3 content words) + 4 options
   ├─ Meeting Scrabble: word bank from transcript (deduped, ≥2 chars)
   ├─ Word Count Bet:  most-frequent non-stopword + initial count (stem-aware)
   ├─ Flash WCB:       quick-fire auto bet (the only auto-starting game)
   ├─ Member Word Bets: any participant opens a bet on a word mid-meeting
   └─ Buzzword Bingo:  cards from transcript buzzwords; marked as said
   ▼
Broadcast game:round:open → clients render game in side panel
   ▼
players submit → game:submit over WS → engine scores on lock (time-boxed)
   ▼
Broadcast game:round:scored + leaderboard → clients update UI
   ▼
Meeting ends → endMeeting.ts → RecapPage: transcript, quiz (Omnilearn graph),
   leaderboard, speaker stats, one-click transcript download
```

Latency budget: utterance → caption broadcast < 500 ms; game round open broadcast
< 500 ms after threshold met. Media is peer-to-peer through LiveKit (< 300 ms typical).
Deepgram first-result cold start can take ~13 s on a fresh session (server buffers
audio until the upstream opens, so real calls self-heal).

---

## 3. Failure modes

| Failure | Behavior | Recovery |
|---|---|---|
| **STT drops** (no caption:event) | Captions UI shows "Captions paused" after 30s; Word Count counter freezes at last known count with "Count paused" note; open rounds are NOT ended early — they wait for the normal timer and score 0 with "No utterances received" if empty | MockAdapter resumes from its script position on the next tick; Deepgram reconnects with backoff; room:state snapshot on rejoin |
| **Mic capture blocked** (autoplay policy / permission) | AudioContext stays `suspended` → no PCM sent, session "connected" but silent; red banner + flat mic-level meter (dancing bars = capture OK, look at WS/Deepgram instead) | `ensureContextRunning()` resumes on user gesture (click/keypress); level meter is the built-in diagnostic |
| **Deepgram cold start** (~13 s) | First captions delayed on fresh sessions; server buffers audio meanwhile | Metadata arrives, buffered audio flushes; subsequent results are fast |
| **Participant disconnects mid-game** | WS close → removed from presence; late-joiner rules apply on rejoin | Rejoin gets current room:state (participants, active round, transcription state) |
| **Host disconnects** | 30s grace timer starts; cancelled if host reconnects | On timeout, first-joined participant promoted via `promoteToHost` + `host:promoted` broadcast |
| **Omnilearn unreachable** | Recording skipped (fire-and-forget, batched, idempotent) | Games/recap fall back to the in-memory buffer; no degradation to core flow |
| **LiveKit unreachable** | Client shows "Video & audio are unavailable" banner; meeting continues in text mode (chat + games + captions still work) | Server TCP-probes the LiveKit URL (IPv4-aware) and reports `livekitAvailable` so clients skip the 8s connect timeout |
| **Late joiner** | Never retroactively scores closed rounds; gets a par bet (floor of average guess) in Word Count Bet | Leaderboard counts par bets as participation for fairness |
| **Abandoned rooms** | Idle >24h rooms + transcripts purged by `cleanup.ts` (interval + on boot) | N/A — data retention by design |

---

## 4. Why LiveKit (and the tradeoff, stated explicitly)

**Choice**: LiveKit (open-source SFU) with LiveKit Cloud as the hosted option.

**Why**: WebRTC mesh degrades badly beyond ~6 participants (N² uplinks); a Selective
Forwarding Unit (SFU) is required for 20–50 participants. LiveKit gives us:
- Open-source, self-hostable (docker-compose or single VPS) → zero-cost dev mode
- LiveKit Cloud for production without ops burden
- First-class React components, token API, and screen-share handling
- Standard WebRTC under the hood (no proprietary SDK lock-in for the transport)

**Tradeoff (explicit)**: LiveKit is a second service to run. In dev we auto-install
a local binary (Linux containers) or connect to LiveKit Cloud via 3 env vars.
The app degrades gracefully to text mode if LiveKit is absent, so a broken media
server never blocks chat/games/captions.

**Deviations from a conventional stack, with reasons**:
- **No Redis**: ephemeral game state fits in-process at MVP scale (20–50/room).
  Adding Redis is a horizontal-scaling step, not an MVP requirement.
- **WebSockets (not LiveKit data channel) for game events**: single-origin WS keeps
  one transport for chat+captions+games; the SFU stays media-only. Simpler and
  works even when LiveKit is down.
- **Server-side STT proxy (`/api/stt`) instead of client-side Deepgram SDK**:
  the API key must never ship in the browser bundle; the server owns the key,
  model selection (nova-2 vs flux), and buffering. Costs one WS hop (browser →
  server → Deepgram), negligible at PCM16 16 kHz.
- **Flat repo (src/ + server/) instead of apps/ + packages/ monorepo**: this is a
  single-app codebase; the client/server split already enforces the package
  boundary. Restructuring into a workspace adds tooling without functional gain
  at this size.
- **Fastify (not Next.js)**: the SPA is Vite+React; Fastify serves the same
  frontend role without SSR complexity for a realtime app.
- **Identity: lightweight guest identity (localStorage userId + unique names per
  room) instead of Clerk/Auth.js**: guests must join without accounts (a prompt
  requirement); a full auth provider is listed as stretch, not DoD.

---

## 5. Privacy & consent (hard requirement)

- Transcription is **opt-in per meeting**: host toggles "Enable captions & games".
- On enable, every client sees a consent banner: "Captions and meeting games are
  now active. This meeting is being transcribed — transcripts are deleted when the
  meeting ends."
- Server only persists transcript events when `transcription_enabled` is true;
  caption:event is dropped otherwise.
- When disabled: captions blank, STT stops, no caption:event sent. Past game
  scores remain (games are consent-gated at the transcript feed level).
- Recap page only shows a transcript if one was consented to (it reads the same
  persisted events — nothing is synthesized).
- Rate limiting (120 req/min/IP, `RATE_LIMIT_MAX`) on all REST APIs; rooms are
  private by default (join requires the room link; optional password).

---

## 6. Security model (added during audit)

1. **Auth on recap + messages routes** — both require a room token
   (`verifyRoomToken`): 401 without token, 403 wrong-room token, 200 valid.
   Client sends `Bearer` on every protected call.
2. **Password lockout** (`utils/passwordGuard.ts`) — per-room + IP fail counter;
   5 fails → 15-min block (correct password ALSO rejected during cooldown),
   `retry-after` honored. Fixed a subtle bug where the record was deleted on every
   call, which would have prevented the lock from ever triggering.
3. **JWT secret enforced** — `loadConfig()` throws on boot in production if
   `JWT_SECRET` is unset. No hardcoded fallback secret exists.
4. **CORS locked down** — restricted to configured `CLIENT_ORIGINS`; arbitrary
   origins get no ACAO header.
5. **No secrets in the repo** — `.env` gitignored; only `.env.example` is tracked;
   all config flows through `server/src/config.ts` from env vars.

---

## 7. Game fairness rules (explicit)

1. **Late joiners do not score retroactively** on rounds that opened before their
   `joinedAt`. The engine compares `joinedAt` vs round `startedAt` at scoring.
2. **Word Count Bet par bet**: late joiners get `floor(average guess of other
   participants)` — a mid-range position, not zero, so they aren't punished for
   joining late.
3. **Leaderboard primary metric**: `pointsPerRound` (total ÷ rounds participated).
   Tiebreaker: total points. This rewards consistency over farming one round.
4. **Par bets count as participation** so late joiners' pointsPerRound isn't inflated.
5. **Who Said That? quality gate** — quote qualifies only if ≥10 words, no
   timestamp overlap with another speaker, ≥3 non-stopword content words; the
   engine skips to the next game type rather than asking a bad question.
6. **Stem-aware word counting** — `countWordInText` matches exact tokens, tokens
   starting with the target (plurals/derivatives), or target-prefix tokens only
   when token ≥4 chars — so stopwords like 'a'/'he' never false-positive.

---

## 8. Build order evidence trail

| Step | Status | Verified by |
|---|---|---|
| Scaffold + deployable hello-world | ✅ | Railway deploy, `/health` OK |
| Room mgmt: create/join/chat/host controls | ✅ | `scripts/ws-test.mjs` (6/6) |
| WebRTC via LiveKit | ✅ | LiveKit Cloud token verified, `livekitAvailable: true` |
| Transcription pipeline (mock first, toggleable real STT) | ✅ | `scripts/caption-test.mjs` (3/3) |
| Consent + privacy flow | ✅ | transcript toggle gate verified |
| Game engine skeleton + side panel | ✅ | `scripts/game-loop-test.mjs` (5/5) |
| Game 1: Who Said That | ✅ | engine round cycle test |
| Game 2: Meeting Scrabble | ✅ | `scripts/games-client-test.mjs` (15/15) |
| Game 3: Word Count Bet | ✅ | scoring tests |
| Games 4–6: Flash WCB, Member Word Bets, Buzzword Bingo | ✅ | round cycle + bingo lookup tests |
| Recap page + leaderboard + transcript download | ✅ | `scripts/recap-test.mjs` (8/8) |
| Server-side Deepgram proxy (key never in browser) | ✅ | STT probe + e2e speech tests |
| Speaker mapping (synthetic STT ids → participants) | ✅ | `scripts/verify-speaker-mapping.mjs` (6/6) |
| Omnilearn meeting-intelligence integration | ✅ | `scripts/omni-smoke.mjs` (live) |
| Security audit (auth, lockout, CORS, JWT, cleanup) | ✅ | `scripts/security-fixes-test.mjs` (16/16) |
| Mic capture deep-fix (AudioWorklet, autoplay policy) | ✅ | live Railway browser loop, level meter |
| Quiet mode (screen-share suspend) | ✅ | implemented; typechecked |

See README.md for run/test instructions and the mobile decision.
