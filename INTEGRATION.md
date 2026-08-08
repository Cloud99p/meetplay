# MeetPlay ⇄ Omnilearn Integration

MeetPlay records meeting utterances into the **Omnilearn knowledge graph** (a
separate service) and reads them back to power games and the recap. This doc
covers how to run Omnilearn, the env vars, the ingest contract, the endpoints,
and how each feature maps to the graph.

> Omnilearn repo: https://github.com/Cloud99p/omnilearn-agent
> Integration plan: `meetplay-omnilearn-integration-prompt.md` (workspace root)

---

## Architecture

```
LiveKit room audio
  → Deepgram streaming STT (diarized: speaker, text, isFinal)
  → MeetPlay backend (existing transcript pipeline)
  → omniClient (server/src/intelligence/omniClient.ts)
      → OmniLearnClient (official SDK — vendored at server/src/intelligence/omnilearn-sdk)
      → POST /api/v1/knowledge/batch   (batched ~10s per room)
  → Omnilearn V1 API → Postgres (knowledge_nodes)
  → games/recap read back:
      → POST /api/v1/knowledge/search   (metadataFilter: { meetingId })
      → POST /api/v1/knowledge/delete   (privacy purge on meeting end)
```

**Transport = the official `@cloud99p/omnilearn-sdk`** (v1.1.0, source vendored
into `server/src/intelligence/omnilearn-sdk/` with a sync header). omniClient
wraps `OmniLearnClient` — the batching / idempotency / graceful-degradation
logic is MeetPlay-specific, the HTTP is all SDK. When the SDK is published to
GitHub Packages, swap the vendored copy for `npm i @cloud99p/omnilearn-sdk`.

Omnilearn runs as a **separate service** ("Meeting Intelligence"). MeetPlay
never imports the brain code — it only talks HTTP through the SDK. If Omnilearn
is down or `OMNILEARN_ENABLED=0`, MeetPlay keeps working from its in-memory
buffer (games degrade gracefully, recap just shows an empty `graph` section).

---

## Running Omnilearn (Meeting Intelligence backend)

```bash
cd omnilearn-agent
# 1. Start Postgres (docker-compose in repo root)
docker compose up -d db

# 2. Configure env — copy .env.example → .env; at minimum DATABASE_URL + PORT.
#    Clerk keys can stay empty for local dev (runs keyless).

# 3. Start the api-server (from artifacts/api-server)
cd artifacts/api-server
npx tsx src/index.ts
# → listens on :8080 by default
```

**Note:** the api-server currently requires `ANTHROPIC_API_KEY` to be present
at import time (dummy value is fine for local dev — the V1 API never calls
Claude) and reads `FREELLM_API_KEY` from the repo-root `.env`.

**Verify:**

```bash
curl http://localhost:8080/api/v1/services/me/stats
# {"success":true,"stats":{"totalNodes":0,...}}
```

---

## MeetPlay env vars

All optional — MeetPlay runs fine without them.

| Var | Default | Purpose |
|-----|---------|---------|
| `OMNILEARN_URL` | `http://localhost:8080` | Omnilearn api-server base URL |
| `OMNILEARN_API_KEY` | *(empty)* | Sent as `x-api-key` when set (prod auth) |
| `OMNILEARN_ENABLED` | `1` | Set `0` to disable recording entirely |
| `OMNILEARN_FLUSH_MS` | `10000` | Batch flush interval per room |

---

## Ingest contract (what MeetPlay sends)

**Batch record** — `POST /api/v1/knowledge/batch` (sent every ~10s per room,
max 100 records):

```json
{
  "records": [
    {
      "type": "utterance",
      "data": {
        "text": "We should prioritize the mobile app redesign",
        "speakerId": "p-abc123",
        "speakerName": "Chidi"
      }
    }
  ],
  "metadata": {
    "meetingId": "<meetplay-room-id>",
    "ts": "2026-08-08T09:12:00.000Z"
  }
}
```

- `metadata.meetingId` is **mandatory** — it scopes every node to a meeting
  and is the key for search filtering and privacy deletion.
- Dedup: omniClient keeps a per-room `speakerId|text|ts` set, so reconnects /
  repeated caption events never double-record.
- Fire-and-forget: recording never blocks or throws into the WS/game hot
  path. Failures are logged as `[omni:ERROR]` and dropped.

---

## Endpoint list (Omnilearn V1 API)

All under `{OMNILEARN_URL}/api/v1`, auth via `x-api-key` (optional in local
dev).

| Endpoint | Method | Used for |
|----------|--------|----------|
| `/knowledge/record` | POST | single utterance (not used by MeetPlay hot path) |
| `/knowledge/batch` | POST | **ingest** — batched utterances per room |
| `/knowledge/search` | POST | **reads** — quotes by `metadataFilter: { meetingId }` |
| `/knowledge/delete` | POST | **privacy** — purge a meeting's nodes on room end |
| `/services/me/stats` | GET | diagnostics (node counts) |

Search body: `{ "metadataFilter": { "meetingId": "<room-id>" }, "type": "utterance", "limit": N }`

Delete body: `{ "metadataFilter": { "meetingId": "<room-id>" } }` — requires a
filter, so there is no blanket-wipe path.

---

## Feature → graph mapping

| Feature | How it uses Omnilearn | Fallback if down |
|---------|----------------------|------------------|
| **Who Said That?** | Round pool prefers quotes from `search(meetingId)` — they persist beyond the bounded in-memory buffer. Falls back graph→graph+local→local. | Local utterance buffer |
| **Recap quiz** | `buildQuizQuestions` gets a graph-augmented utterance pool (whole meeting, not just buffer tail). | Local buffer |
| **Recap page** | Response includes `graph: { available, recordedUtterances, quotes }` from `search`. | Empty `graph` section |
| **Word Count Bet / Scrabble** | Unchanged — local counting (word suggestion from graph tfidf is Phase 2). | n/a |
| **Meeting end** | `omniClient.flushRoom()` (drain stragglers) + `omniClient.deleteMeeting()` (privacy purge) — best-effort, non-blocking. | No-op |

---

## Files touched

- `server/src/intelligence/omnilearn-sdk/` — **new**: vendored `@cloud99p/omnilearn-sdk`
  v1.1.0 source (client.ts + types.ts + index.ts, NodeNext `.js` specifiers,
  header notes sync origin). Do not edit by hand.
- `server/src/intelligence/omniClient.ts` — **new**: batched, idempotent,
  fire-and-forget wrapper around `OmniLearnClient` (recordBatch/search/delete).
- `server/src/ws/handler.ts` — `caption:event` → `omniClient.recordUtterance`.
- `server/src/games/engine.ts` — Who-Said-That pool + recap quiz pool draw on
  the graph with local fallback ladder.
- `server/src/routes/recap.ts` — recap response gains the `graph` section.
- `server/src/endMeeting.ts` — flush + delete meeting nodes on room end.
- `server/src/config.ts` / `.env.example` — `OMNILEARN_*` env vars.
- `server/scripts/omni-smoke.mjs` — raw-API round trip (node).
- `server/scripts/omni-smoke-sdk.ts` — **SDK** round trip via the vendored
  client (npx tsx) — batch → search → delete → search.

---

## Phase 2 (skipped, worth revisiting)

- **Meeting copilot chat** — Omnilearn `/api/omni/chat` + synthesizer (Claude
  tool-calling) for a post-meeting assistant.
- **Ontology per company** — `ontology.ts` concepts → themed bingo cards.
- **Mesh network** — `network.ts` multi-company knowledge sharing (out of
  scope for single-company meetings).
- **Per-user RLS / attentiveness profiles** — map MeetPlay user ids → Omnilearn
  Clerk ids to enable per-user row-level security and talk-time analytics in
  the graph.
- **Live game panel feed** — `POST /api/v1/knowledge/stream` (SSE) to push new
  nodes to the games panel in real time instead of polling search.
