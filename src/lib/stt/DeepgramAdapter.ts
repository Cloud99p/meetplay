import type { STTAdapter, Utterance } from './STTAdapter';

/**
 * Production STT adapter — streams browser mic audio to the SERVER-SIDE
 * Deepgram proxy (/api/stt). The Deepgram API key NEVER ships to the client;
 * it lives in DEEPGRAM_API_KEY on the server (Railway env var).
 *
 * Flow:
 *   browser mic -> PCM16 16kHz mono -> WS /api/stt (same origin)
 *   -> server forwards with Authorization: Token <key> -> Deepgram Live API
 *   -> diarized Results JSON streamed back to this adapter.
 *
 * Graceful degradation: if the socket fails or closes unexpectedly, we
 * reconnect with exponential backoff. If the adapter is stopped, everything
 * is torn down cleanly.
 */
export class DeepgramAdapter implements STTAdapter {
  onUtterance?: (utterance: Utterance) => void;

  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private running = false;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInterimText = '';

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownMedia();
    if (this.ws) {
      try {
        const ws = this.ws;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'CloseStream' }));
          ws.close();
        } else if (ws.readyState === WebSocket.CONNECTING) {
          // Browser throws "WebSocket is closed before the connection is
          // established" if you close() a socket still in the handshake.
          // Detach handlers and drop references instead — no reconnect is
          // scheduled because this.stopped is already true.
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
        } else {
          ws.close();
        }
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  // -------------------------------------------------------------------------
  // Proxy socket (same origin — key stays on the server)
  // -------------------------------------------------------------------------

  private proxyUrl(): string {
    const base = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';
    if (base) return `${base.replace(/\/$/, '')}/api/stt`.replace(/^http/, 'ws');
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/api/stt`;
  }

  private connect(): void {
    if (this.stopped) return;

    try {
      this.ws = new WebSocket(this.proxyUrl());
    } catch (err) {
      console.error('[DeepgramAdapter] Failed to open WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      // Guard: stop() may have run while the handshake was in flight.
      if (this.stopped || !this.ws) {
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.reconnectAttempts = 0;
      // Tell the server which Deepgram config to use. The server holds the key.
      this.ws?.send(
        JSON.stringify({
          type: 'Configure',
          encoding: 'linear16',
          sample_rate: 16000,
          channels: 1,
          model: 'nova-2',
          diarize: true,
          interim_results: true,
          punctuate: true,
        }),
      );
      this.startMicrophone();
    };

    this.ws.onmessage = (event) => this.handleMessage(event.data);

    this.ws.onerror = (err) => {
      console.warn('[DeepgramAdapter] socket error:', err);
    };

    this.ws.onclose = () => {
      this.teardownMedia();
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.type === 'Error') {
      console.warn('[DeepgramAdapter] server error:', msg.message);
      return;
    }

    // ---- v2 Flux: turn-based events (StartOfTurn / Update / EndOfTurn) ----
    if (msg.type === 'TurnInfo' || typeof msg.event === 'string') {
      const event = msg.event ?? msg.type;
      const text = (msg.transcript ?? '').trim();
      if (event === 'StartOfTurn') {
        this.lastInterimText = '';
        return;
      }
      if (event === 'EndOfTurn' || event === 'EagerEndOfTurn') {
        this.lastInterimText = '';
        if (text) {
          this.onUtterance?.({
            speakerId: 'local',
            text,
            timestamp: Date.now(),
            isFinal: true,
          });
        }
        return;
      }
      if (event === 'Update' || event === 'TurnUpdate') {
        // v2 Update events resend the FULL accumulated turn text — only emit
        // when it changed, so the captions overlay doesn't get spammed.
        // Games ignore non-final text anyway.
        if (text && text !== this.lastInterimText) {
          this.lastInterimText = text;
          this.onUtterance?.({
            speakerId: 'local',
            text,
            timestamp: Date.now(),
            isFinal: false,
          });
        }
        return;
      }
      return;
    }

    // ---- v1: Results messages (diarized multi-speaker) ----
    if (msg.type !== 'Results' || !msg.channel?.alternatives?.length) return;

    const alt = msg.channel.alternatives[0];
    const isFinal = !!msg.is_final;

    if (isFinal) {
      // Final result: group words by speaker and emit one utterance per speaker.
      const bySpeaker = new Map<number, string[]>();
      for (const w of alt.words ?? []) {
        const spk = typeof w.speaker === 'number' ? w.speaker : 0;
        if (!bySpeaker.has(spk)) bySpeaker.set(spk, []);
        bySpeaker.get(spk)!.push(w.word);
      }
      for (const [spk, words] of bySpeaker) {
        const text = words.join(' ').trim();
        if (!text) continue;
        this.onUtterance?.({
          speakerId: `speaker-${spk}`,
          text,
          timestamp: Date.now(),
          isFinal: true,
        });
      }
    } else {
      // Interim: emit non-final captions for the live overlay (no reliable
      // speaker attribution in interim results — games ignore non-final text).
      const text = alt.transcript?.trim();
      if (!text) return;
      this.onUtterance?.({
        speakerId: 'unknown',
        text,
        timestamp: Date.now(),
        isFinal: false,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Microphone capture -> PCM16 @ 16kHz mono -> socket
  // -------------------------------------------------------------------------

  private async startMicrophone(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error('[DeepgramAdapter] getUserMedia failed:', err);
      return;
    }

    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new Ctx();
    this.source = this.audioContext.createMediaStreamSource(this.stream);

    // ScriptProcessorNode (4096-frame buffer) — universally supported and
    // dependency-free. (AudioWorklet is the modern alternative; swap later if
    // latency becomes an issue.)
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0); // Float32 [-1, 1]
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.ws.send(pcm.buffer);
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  private teardownMedia(): void {
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
