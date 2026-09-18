import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { loadConfig } from '../config.js';

/**
 * Server-side Deepgram Live proxy.
 *
 * The browser NEVER sees the Deepgram API key. The client opens a WebSocket
 * to the same origin (/api/stt), and the server opens the upstream connection
 * to Deepgram carrying the key in an Authorization header (WebSocket headers
 * are only possible server-side).
 *
 * Model-aware endpoint (DEEPGRAM_MODEL env):
 *   - nova-2            -> v1 /listen + diarize=true  (multi-speaker; powers
 *                         the "Who Said That?" game)
 *   - flux-general-en   -> v2 /listen (turn-based Flux events:
 *                         StartOfTurn / TurnUpdate / EndOfTurn) — single
 *                         speaker stream, ultra-low latency, end-of-turn
 *                         detection (eot_threshold / eot_timeout_ms).
 *
 * Flow:  client <--ws--> server <--ws+auth--> api.deepgram.com
 * - Client messages (Configure JSON, then raw PCM16 audio) are forwarded up.
 * - Deepgram result events are forwarded down.
 * - Messages from the client before the upstream socket opens are buffered
 *   and flushed on open (avoids the Configure race).
 */
// ── Abuse + cost guards ─────────────────────────────────────────────────────
// /api/stt proxies a credentialed Deepgram session and deliberately requires no
// account (students must not have to log in to be captioned) — which also means
// anyone who can reach the URL can spend the project's credits. These counters
// are the cheapest possible defence: caps on concurrent sessions, wall-clock and
// bytes, plus a global kill switch that needs no deploy (STT_ENABLED=0).
let activeSessions = 0;
const sessionsByIp = new Map<string, number>();

export async function sttRoutes(app: FastifyInstance) {
  app.get('/api/stt', { websocket: true }, (socket, req) => {
    const cfg = loadConfig();

    // Reason codes are mirrored in the browser adapter, which stops reconnecting
    // on 1008/1013 — otherwise a capped client just hammers the door.
    const refuse = (code: string, message: string, closeCode: number, reason: string) => {
      try {
        socket.send(JSON.stringify({ type: 'Error', code, message }));
      } catch {
        /* socket already gone */
      }
      socket.close(closeCode, reason);
    };

    if (!cfg.sttEnabled) {
      console.warn('[stt] refused: caption relay disabled by STT_ENABLED=0');
      refuse('STT_DISABLED', 'Live captions are temporarily unavailable.', 1013, 'captions disabled');
      return;
    }

    if (!cfg.deepgramApiKey) {
      refuse(
        'STT_UNCONFIGURED',
        'Deepgram is not configured on the server (missing DEEPGRAM_API_KEY).',
        1013,
        'not configured',
      );
      return;
    }

    // Caps are counted before any upstream connection is opened.
    const ip = req?.ip ?? 'unknown';
    if (activeSessions >= cfg.sttMaxConcurrent) {
      console.warn(`[stt] refused: ${activeSessions} sessions already open (STT_MAX_CONCURRENT)`);
      refuse('STT_BUSY', 'Captions are at capacity right now — try again in a moment.', 1013, 'busy');
      return;
    }
    const forIp = sessionsByIp.get(ip) ?? 0;
    if (forIp >= cfg.sttMaxPerIp) {
      console.warn(`[stt] refused: ${forIp} sessions from ${ip} (STT_MAX_PER_IP)`);
      refuse('STT_IP_LIMIT', 'Too many caption sessions from this network.', 1013, 'too many sessions');
      return;
    }
    activeSessions++;
    sessionsByIp.set(ip, forIp + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeSessions = Math.max(0, activeSessions - 1);
      const n = (sessionsByIp.get(ip) ?? 1) - 1;
      if (n <= 0) sessionsByIp.delete(ip);
      else sessionsByIp.set(ip, n);
    };
    socket.on('close', release);

    const model = cfg.deepgramModel;
    const isFlux = model.startsWith('flux');
    const connId = Math.random().toString(36).slice(2, 8);
    console.log(`[stt:${connId}] client connected (model=${model}, sessions=${activeSessions})`);

    // Wall-clock cap: a runaway tab or a forgotten room must not transcribe for
    // ever. Far above real use (a tutorial is ≤45 min), so it only catches abuse.
    const sessionTimer = setTimeout(() => {
      console.warn(`[stt:${connId}] session limit reached (${cfg.sttMaxSessionSeconds}s) — closing`);
      refuse('STT_SESSION_LIMIT', 'Caption session reached its time limit.', 1008, 'session limit');
    }, cfg.sttMaxSessionSeconds * 1000);

    const params = new URLSearchParams({
      model,
      encoding: 'linear16',
      sample_rate: '16000',
      // smart_format is deliberately OFF: it post-processes numbers/dates
      // ("twenty five" -> "25") which breaks the word-count games and adds
      // latency on the streaming path.
    });

    if (isFlux) {
      // v2 Flux: turn-based, end-of-turn detection. No diarization (single
      // speaker) and NO v1-only params — the v2 endpoint rejects language,
      // punctuate, interim_results, vad_events, channels (400). Flux is
      // English-only, punctuates by default, and streams Update events natively.
      // Low-latency mode (per Deepgram docs): eager_eot_threshold enables
      // EagerEndOfTurn at sentence boundaries during continuous speech;
      // eot_timeout_ms caps silence before a forced EndOfTurn.
      params.set('eot_threshold', '0.7');
      // 0.6 (docs: 0.6-0.8 = conservative): fewer false early EOTs that cut
      // sentences off mid-speech. 0.4 caused truncated finals like
      // "And why is he sending to".
      params.set('eager_eot_threshold', '0.6');
      params.set('eot_timeout_ms', '3000');
    } else {
      // v1: diarized multi-speaker (required for "Who Said That?" game).
      // Options mirror Deepgram's canonical streaming example:
      //   model nova-2, language en, interim_results, endpointing 10ms,
      //   diarize, punctuate, vad_events. no_delay returns results as soon
      //   as they're ready instead of waiting for a better hypothesis —
      //   keeps live captions/word counts tight during fast speech.
      params.set('language', cfg.deepgramLanguage);
      params.set('diarize', 'true');
      params.set('interim_results', 'true');
      params.set('punctuate', 'true');
      params.set('endpointing', '10');
      params.set('vad_events', 'true');
      params.set('channels', '1');
      params.set('no_delay', 'true');
    }

    const endpoint = isFlux ? 'wss://api.deepgram.com/v2/listen' : 'wss://api.deepgram.com/v1/listen';

    let upstream: WebSocket;
    try {
      upstream = new WebSocket(`${endpoint}?${params.toString()}`, {
        headers: { Authorization: `Token ${cfg.deepgramApiKey}` },
      });
    } catch (err) {
      console.error('[stt-proxy] failed to open upstream:', err);
      socket.send(JSON.stringify({ type: 'Error', message: 'Failed to reach Deepgram from the server.' }));
      socket.close();
      return;
    }

    let upstreamOpen = false;
    const pending: (string | Buffer)[] = [];
    let pendingBytes = 0;
    let audioBytes = 0;
    let resultsCount = 0;
    let lastTextLog = 0;

    const flushPending = () => {
      if (!upstreamOpen) return;
      for (const msg of pending) {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
      }
      pending.length = 0;
      pendingBytes = 0;
    };

    upstream.on('open', () => {
      upstreamOpen = true;
      console.log(`[stt:${connId}] upstream Deepgram OPEN`);
      flushPending();
    });

    // Upstream -> client (Results JSON, TurnInfo events, Metadata, etc.)
    upstream.on('message', (data) => {
      // Protocol-level complaints about OUR own client messages are our bug, not
      // the user's: relaying them makes a benign internal mistake look like a
      // failed recording session in the browser console. Log them here instead,
      // and still forward everything else verbatim.
      let relay = true;
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'Error' && parsed.code === 'UNPARSABLE_CLIENT_MESSAGE') {
          console.warn(
            `[stt:${connId}] upstream rejected a client message (${parsed.description ?? 'no description'}) — not relaying`,
          );
          relay = false;
        }
      } catch {
        /* not JSON (binary audio frames are upstream->us only) */
      }
      if (relay && socket.readyState === socket.OPEN) socket.send(data.toString());
      // ---- diagnostic logging: does Deepgram actually hear/transcribe? ----
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'Metadata') {
          console.log(`[stt:${connId}] Deepgram Metadata received (session ready)`);
        } else if (msg.type === 'Results') {
          resultsCount++;
          const alt = msg.channel?.alternatives?.[0];
          const transcript = alt?.transcript ?? '';
          const isFinal = !!msg.is_final;
          // Log finals always; log interims at most once per 3s (they're noisy)
          const now = Date.now();
          if (isFinal || now - lastTextLog > 3000) {
            lastTextLog = now;
            const preview = transcript.slice(0, 120) || '(empty transcript)';            console.log(
              `[stt:${connId}] Deepgram ${isFinal ? 'FINAL' : 'interim'} transcript="${preview}" words=${alt?.words?.length ?? 0} (results#${resultsCount})`,
            );
          }
        } else if (msg.type === 'TurnInfo' || typeof msg.event === 'string') {
          // v2 Flux: turn lifecycle. Log EOT events with turn_index + EOT
          // confidence (also forwarded to the client below); Updates are
          // noisy so log them at most once per 3s.
          const event = msg.event ?? msg.type;
          const transcript = (msg.transcript ?? '').slice(0, 120);
          if (event === 'Update' || event === 'TurnUpdate') {
            const now = Date.now();
            if (now - lastTextLog > 3000) {
              lastTextLog = now;
              console.log(`[stt:${connId}] Update transcript="${transcript}"`);
            }
          } else {
            const conf = msg.end_of_turn_confidence;
            const confStr = typeof conf === 'number' ? conf.toFixed(2) : '-';
            console.log(
              `[stt:${connId}] ${event} turn=${msg.turn_index ?? '?'} confidence=${confStr} transcript="${transcript}"`,
            );
          }
        } else if (msg.type === 'SpeechStarted') {
          console.log(`[stt:${connId}] Deepgram SpeechStarted`);
        }
      } catch {
        /* non-JSON upstream frame */
      }
    });

    upstream.on('error', (err) => {
      console.error('[stt-proxy] upstream error:', err.message);
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'Error', message: 'Deepgram upstream error.' }));
        // The upstream is broken — close the client socket so the browser
        // adapter reconnects and gets a FRESH upstream. Without this, the
        // client keeps streaming audio into a dead pipe and captions stop
        // mid-call forever ("captions freeze" bug).
        socket.close();
      }
    });

    // Surface the REAL reason behind handshake failures (the ws library only
    // says "Unexpected server response: 400" — the body has the actual
    // INVALID_QUERY_PARAMETER / auth error from Deepgram).
    upstream.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => {
        console.error(`[stt-proxy] upstream handshake failed: HTTP ${res.statusCode} ${body.slice(0, 500)}`);
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'Error', message: `Deepgram upstream error (HTTP ${res.statusCode}).` }));
          socket.close();
        }
      });
    });

    // ── Liveness heartbeats (fixes "captions stop mid-call and never resume") ──
    // 1) KeepAlive upstream every 30s: Deepgram closes Live sessions that sit
    //    idle (a silence gap in a meeting is enough), which would otherwise
    //    kill captions until someone notices.
    //
    //    BUT: KeepAlive is a v1 protocol message. On the Flux endpoint (v2) the
    //    only client messages are CloseStream, ForceEndTurn and Configure, so
    //    every KeepAlive we sent came back as
    //      {"type":"Error","code":"UNPARSABLE_CLIENT_MESSAGE", ...}
    //    which the proxy relayed to the browser as a scary "server error", and
    //    which risks the session being closed as malformed. Flux meters turns
    //    and audio keeps flowing, so the keepalive isn't needed there.
    // 2) stt:keepalive to the client every 10s: the browser adapter's watchdog
    //    treats "no server message for a while" as a dead socket and forces a
    //    reconnect. This frame guarantees a healthy session never false-positives.
    const upstreamKeepalive = isFlux
      ? null
      : setInterval(() => {
          if (upstream.readyState === WebSocket.OPEN) {
            try {
              upstream.send(JSON.stringify({ type: 'KeepAlive' }));
            } catch {
              /* ignore */
            }
          }
        }, 30000);

    const clientKeepalive = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'stt:keepalive', t: Date.now() }));
      }
    }, 10000);

    // 3) Upstream TCP liveness (half-open detection): a connection can die
    //    without a FIN/RST (network partition, NAT timeout) — neither 'error'
    //    nor 'close' fires, keepalives still flow to the client, and captions
    //    silently stop forever. Protocol-level ping/pong catches this: if a
    //    ping isn't answered within the next interval, terminate() force-
    //    closes the socket (fires 'close') -> client socket closes -> browser
    //    adapter reconnects with a FRESH upstream.
    let upstreamPonged = true;
    upstream.on('pong', () => {
      upstreamPonged = true;
    });
    const upstreamPing = setInterval(() => {
      if (upstream.readyState !== WebSocket.OPEN) return;
      if (!upstreamPonged) {
        console.warn(`[stt:${connId}] upstream ping timeout — terminating half-open connection`);
        try {
          upstream.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      upstreamPonged = false;
      try {
        upstream.ping();
      } catch {
        try {
          upstream.terminate();
        } catch {
          /* ignore */
        }
      }
    }, 30000);

    upstream.on('close', () => {
      if (socket.readyState === socket.OPEN) socket.close();
    });

    // Client -> upstream (binary PCM16 audio; control messages filtered)
    socket.on('message', (data: any) => {
      if (typeof data === 'string') {
        // The client sends a Configure JSON on connect. v2 Flux rejects it
        // (only thresholds/keyterms/language_hints/profanity_filter are valid)
        // and v1 doesn't need it — the upstream URL params are authoritative
        // for encoding/sample_rate/model. Drop Configure, forward CloseStream.
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'CloseStream') {
            if (upstreamOpen && upstream.readyState === WebSocket.OPEN) upstream.send(data);
            else pending.push(data);
          } else {
            console.log(`[stt:${connId}] client msg dropped: ${data.slice(0, 120)}`);
          }
        } catch {
          // non-JSON string — pass through
          if (upstreamOpen && upstream.readyState === WebSocket.OPEN) upstream.send(data);
          else pending.push(data);
        }
        return;
      }
      const buf = data as Buffer;
      audioBytes += buf.byteLength;
      if (audioBytes > cfg.sttMaxAudioBytes) {
        console.warn(`[stt:${connId}] audio cap reached (${audioBytes} bytes) — closing`);
        refuse('STT_SESSION_LIMIT', 'Caption session reached its size limit.', 1008, 'session limit');
        return;
      }
      if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
        upstream.send(buf);
      } else {
        pending.push(buf);
        pendingBytes += buf.byteLength;
        // Bound the buffer: if Deepgram is down for minutes, pending would
        // otherwise grow unbounded (memory leak). Drop OLDEST audio (keep the
        // most recent ~8MB) so a fresh upstream still gets current audio.
        while (pendingBytes > 8 * 1024 * 1024 && pending.length > 1) {
          const dropped = pending.shift() as Buffer;
          pendingBytes -= dropped.byteLength ?? 0;
        }
      }
    });

    socket.on('close', () => {
      clearTimeout(sessionTimer);
      console.log(`[stt:${connId}] client closed (audioBytes=${audioBytes}, results=${resultsCount})`);
      if (upstreamKeepalive) clearInterval(upstreamKeepalive);
      clearInterval(clientKeepalive);
      clearInterval(upstreamPing);
      try {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify({ type: 'CloseStream' }));
          upstream.close();
        }
      } catch {
        /* ignore */
      }
    });
  });
}
