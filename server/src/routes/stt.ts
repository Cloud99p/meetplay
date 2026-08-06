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
 * Flow:  client <--ws--> server <--ws+auth--> api.deepgram.com
 * - Client messages (Configure JSON, then raw PCM16 audio) are forwarded up.
 * - Deepgram Results messages are forwarded down.
 * - Messages from the client before the upstream socket opens are buffered
 *   and flushed on open (avoids the Configure race).
 */
export async function sttRoutes(app: FastifyInstance) {
  app.get('/api/stt', { websocket: true }, (socket) => {
    const cfg = loadConfig();
    if (!cfg.deepgramApiKey) {
      socket.send(JSON.stringify({ type: 'Error', message: 'Deepgram is not configured on the server (missing DEEPGRAM_API_KEY).' }));
      socket.close();
      return;
    }

    const params = new URLSearchParams({
      model: 'nova-2',
      diarize: 'true',
      interim_results: 'true',
      punctuate: 'true',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
    });

    let upstream: WebSocket;
    try {
      upstream = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
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

    const flushPending = () => {
      if (!upstreamOpen) return;
      for (const msg of pending) {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
      }
      pending.length = 0;
    };

    upstream.on('open', () => {
      upstreamOpen = true;
      flushPending();
    });

    // Upstream -> client (Results JSON, Metadata, etc.)
    upstream.on('message', (data) => {
      if (socket.readyState === socket.OPEN) socket.send(data.toString());
    });

    upstream.on('error', (err) => {
      console.error('[stt-proxy] upstream error:', err.message);
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'Error', message: 'Deepgram upstream error.' }));
      }
    });

    upstream.on('close', () => {
      if (socket.readyState === socket.OPEN) socket.close();
    });

    // Client -> upstream (Configure JSON, then binary PCM16 audio)
    socket.on('message', (data) => {
      if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
        upstream.send(data as Buffer);
      } else {
        pending.push(data as Buffer);
      }
    });

    socket.on('close', () => {
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
