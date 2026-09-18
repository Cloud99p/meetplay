# Speech-to-text (captions)

The browser records only its **own** mic and streams PCM16 16 kHz mono to
`GET /api/stt` (a WebSocket on our own server). The server proxies it to
Deepgram with the API key in an `Authorization` header — **the key never reaches
the browser**. Two upstream shapes are supported, selected by `DEEPGRAM_MODEL`:

| Model | Endpoint | Shape |
|---|---|---|
| `flux-general-en` (default) | v2 `/listen` | turn-based `TurnInfo` events (StartOfTurn / Update / EagerEndOfTurn / EndOfTurn / TurnResumed) |
| `nova-2` | v1 `/listen` | `Results` messages with `is_final` + diarization |

Clients then send `caption:event` frames back over `/ws`, which the server
attributes, stores and feeds to the games engine.

## Three production bugs, fixed here — don't regress them

1. **`speakerId: 'local'` killed every caption on Postgres.**
   The adapters tag utterances with synthetic ids (`local` from WebSpeech,
   `speaker-0` from Deepgram diarization, `unknown` from Flux). The caption
   handler looked that id up in the database to resolve a name. The in-memory
   store accepts any string key, so dev worked; Postgres throws
   `invalid input syntax for type uuid: "local"` (22P02), which aborted the
   handler **before** the broadcast, the transcript row and the game feed. So
   captions never reached other participants and nothing was ever persisted.
   → All client-supplied ids go through `isUuid()` before becoming query
   parameters. Locked by `npm run verify:caption`.

2. **Messages sent right after connect were dropped.** The socket's `message`
   listener was attached after several `await`s (room load, passive games, state
   snapshot), so anything arriving during setup vanished silently. Inbound
   frames are now queued and replayed in order once initialisation finishes.

3. **`KeepAlive` on a Flux session.** The proxy sent `{"type":"KeepAlive"}` every
   30s — a **v1** message. Flux accepts only `CloseStream`, `ForceEndTurn`,
   `Configure`, so Deepgram replied
   `{"type":"Error","code":"UNPARSABLE_CLIENT_MESSAGE"}` and the proxy relayed
   that to the browser as a scary server error (and risked the session being
   closed as malformed). The upstream keepalive is now v1-only, and
   protocol-level complaints about our own messages are logged server-side
   instead of being relayed. Locked by `npm run verify:stt`.

## Abuse & cost guards

`/api/stt` is a credentialed Deepgram relay that deliberately requires **no**
account — students must not have to log in to be captioned — which also means
anyone who can reach the URL can spend the project's credits. The guards below
are backstops, not metering: their defaults sit far above real use and only catch
a runaway room or an outsider.

| Env var | Default | Effect |
|---|---|---|
| `STT_ENABLED` | `1` | `0` refuses every new session — the kill switch, no deploy needed |
| `STT_MAX_SESSION_SECONDS` | `5400` (90 min) | wall-clock cap per session |
| `STT_MAX_AUDIO_BYTES` | `209715200` (200 MB ≈ 1.7 h of PCM16) | byte cap per session |
| `STT_MAX_CONCURRENT` | `60` | total open caption sessions |
| `STT_MAX_PER_IP` | `30` | sessions from one address (a classroom shares one NAT) |

Refusals are always explained before closing — the client shows the message and
**stops reconnecting** on those codes, because retrying against a server that
will refuse again just burns the user's battery:

| Close | Code sent | Meaning |
|---|---|---|
| 1013 | `STT_DISABLED` / `STT_BUSY` / `STT_IP_LIMIT` / `STT_UNCONFIGURED` | try again later |
| 1008 | `STT_SESSION_LIMIT` | this session hit its time or size limit |

Locked by `npm run verify:stt:guards` (boots the real server with each cap set
tight and drives it over a real WebSocket).

## Verification

```bash
npm run verify:caption   # WS + real Postgres: synthetic speaker ids, transcript rows, dropped-frame case
npm run verify:stt       # live Deepgram, ~36s: key works, handshake OK, no protocol errors
```

`verify:stt` intentionally runs **past the 30s keepalive window** — a shorter run
passes even with the bug present.

## Reading the logs

| Log | Meaning |
|---|---|
| `[stt:X] upstream Deepgram OPEN` | handshake with Deepgram succeeded |
| `[stt:X] Update transcript="…"` | interim (Flux) — noisy, logged at most every 3s |
| `[stt:X] EndOfTurn turn=N confidence=…` | a finalized turn → becomes a `caption:event` |
| `[stt:X] results=0` | normal on Flux (it emits `TurnInfo`, not `Results` — the counter is v1-shaped) |
| `[caption] … rawSpeaker=local -> speaker=<uuid>` | synthetic id correctly attributed to the sender |
| `handle error: … uuid: "local"` | bug #1 is back |
| `not relaying` | Deepgram rejected one of OUR messages (bug #3 is back) |
