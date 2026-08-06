# MeetPlay — Architecture

**Status**: Implemented and verified. This document describes the system as built.

---

## 1. Component responsibilities and boundaries

```
┌───────────────────────────── Browser (React SPA) ─────────────────────────────┐
│                                                                               │
│  Lobby (create/join) ── MeetingRoom ── RecapPage                              │
│     │                        │                                                │
│     │ REST (/api)            │ WS (/ws) + LiveKit (media)                     │
│     ▼                        ▼                                                │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │ Fastify API server (single container in prod)                        │    │
│  │  ├─ REST routes: rooms, join, transcript toggle, recap, livekit      │    │
│  │  ├─ WebSocket hub: chat, captions, game events, presence             │    │
│  │  ├─ RoomGameEngine: state machine, timers, scoring, leaderboard      │    │
│  │  ├─ STT adapters: Mock (default) / WebSpeech / pluggable real STT    │    │
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
- **DB layer** (queries.ts → memory.ts | pgQueries.ts) is the only place that touches storage; the engine and routes go through it.

---

## 2. Data flow: spoken word → game state → client render

```
participant speaks
   │  (LiveKit audio track)
   ▼
STT adapter (MockAdapter by default; WebSpeech/real STT behind same interface)
   │  utterance { speakerId, text, isFinal, timestamp }
   ▼
Client sends caption:event over WebSocket
   ▼
Server WS handler: [1] persists transcript event, [2] broadcasts caption:event
   │
   ▼
RoomGameEngine.addUtterance()
   │  buffer grows; if ≥8 utterances & cooldown passed & no active round:
   ▼
maybeStartRound() → builds round data per game type:
   ├─ Who Said That: quality-gated quote + 4 speaker options
   ├─ Scrabble: word bank from transcript
   └─ Word Count Bet: most-frequent non-stopword + initial count
   ▼
Broadcast game:round:open → clients render game in side panel
   ▼
players submit → game:submit over WS → engine scores on lock (time-boxed)
   ▼
Broadcast game:round:scored + leaderboard → clients update UI
```

Latency budget: utterance → caption broadcast < 500 ms; game round open broadcast
< 500 ms after threshold met. Media is peer-to-peer through LiveKit (< 300 ms typical).

---

## 3. Failure modes

| Failure | Behavior | Recovery |
|---|---|---|
| **STT drops** (no caption:event) | Captions UI shows "Captions paused" after 30s; Word Count counter freezes at last known count with "Count paused" note; open rounds are NOT ended early — they wait for the normal timer and score 0 with "No utterances received" if empty | MockAdapter resumes from its script position on the next tick; real STT reconnect sends room:state snapshot |
| **Participant disconnects mid-game** | WS close → removed from presence; late-joiner rules apply on rejoin | Rejoin gets current room:state (participants, active round, transcription state) |
| **Host disconnects** | 30s grace timer starts; if host reconnects it's cancelled | On timeout, first-joined participant promoted via `promoteToHost` + `host:promoted` broadcast |
| **Redis restarts** | **N/A** — no Redis. Ephemeral game state lives in the server process (per-room engine map). This is a documented tradeoff for MVP scale (20–50 users/room fits one node); swap to Redis when scaling horizontally | Engine map is recreated per room on demand; persistent rounds/scores live in Postgres |
| **LiveKit unreachable** | Client shows "Video & audio are unavailable" banner; meeting continues in text mode (chat + games + captions still work) | Server TCP-probes the LiveKit URL (cloud-aware) and reports `livekitAvailable` so clients skip the 8s connect timeout |
| **Late joiner** | Never retroactively scores closed rounds; gets a par bet (floor of average guess) in Word Count Bet | Leaderboard counts par bets as participation for fairness |

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

**Deviations from the prompt, with reasons**:
- **No Redis**: ephemeral game state fits in-process at MVP scale (20–50/room).
  Adding Redis is a horizontal-scaling step, not an MVP requirement. Documented in
  failure modes above.
- **WebSockets (not LiveKit data channel) for game events**: single-origin WS keeps
  one transport for chat+captions+games; the SFU stays media-only. Simpler and
  works even when LiveKit is down.
- **Flat repo (src/ + server/) instead of apps/ + packages/ monorepo**: this is a
  single-app codebase; the client/server split already enforces the package
  boundary. Restructuring into a workspace adds tooling without functional gain
  at this size.
- **Fastify (not Next.js)**: the prompt allowed Fastify/NestJS/FastAPI for backend;
  the SPA is Vite+React, which serves the same frontend role as Next.js without
  SSR complexity for a realtime app.
- **Identity: lightweight guest identity (localStorage userId + unique names per
  room) instead of Clerk/Auth.js**: guests must join without accounts (a prompt
  requirement); a full auth provider is listed as stretch, not DoD.

---

## 5. Privacy & consent (hard requirement, implemented before games)

- Transcription is **opt-in per meeting**: host toggles "Enable captions & games".
- On enable, every client sees a consent banner: "Captions and meeting games are
  now active. This meeting is being transcribed — transcripts are deleted when the
  meeting ends."
- Server only persists transcript events when `transcription_enabled` is true;
  caption:event is dropped otherwise.
- When disabled: captions blank, mock STT stops, no caption:event sent. Past game
  scores remain (games are consent-gated at the transcript feed level).
- Recap page only shows a transcript if one was consented to (it reads the same
  persisted events — nothing is synthesized).
- Rate limiting (120 req/min/IP) on all REST APIs; rooms are private by default
  (join requires the room link; optional password).

---

## 6. Game fairness rules (explicit)

1. **Late joiners do not score retroactively** on rounds that opened before their
   `joinedAt`. The engine compares `joinedAt` vs round `startedAt` at scoring.
2. **Word Count Bet par bet**: late joiners get `floor(average guess of other
   participants)` — a mid-range position, not zero, so they aren't punished for
   joining late.
3. **Leaderboard primary metric**: `pointsPerRound` (total ÷ rounds participated).
   Tiebreaker: total points. This rewards consistency over farming one round.
4. **Par bets count as participation** so late joiners' pointsPerRound isn't inflated.

---

## 7. Build order evidence trail

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
| Recap page + leaderboard | ✅ | `scripts/recap-test.mjs` (8/8) |
| Quiet mode (screen-share suspend) | ✅ | implemented; typechecked |
| Rate limiting | ✅ | implemented; typechecked |

See README.md for run/test instructions and the mobile decision.
