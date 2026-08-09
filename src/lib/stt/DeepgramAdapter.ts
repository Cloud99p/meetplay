import type { STTAdapter, Utterance } from './STTAdapter';

/**
 * Production STT adapter — streams browser mic audio to the SERVER-SIDE
 * Deepgram proxy (/api/stt). The Deepgram API key NEVER ships to the client;
 * it lives in DEEPGRAM_API_KEY on the server (Railway env var).
 *
 * Flow:
 *   browser mic -> PCM16 16kHz mono -> WS /api/stt (same origin)
 *   -> server forwards with Authorization: Token <key> -> Deepgram Live API
 *   -> Results JSON (v1 diarized) or TurnInfo events (v2 Flux) streamed back
 *      to this adapter. Default model is flux-general-en (v2, low latency,
 *      turn-based); nova-2 (v1 diarized) stays supported via DEEPGRAM_MODEL.
 *
 * Graceful degradation: if the socket fails or closes unexpectedly, we
 * reconnect with exponential backoff. If the adapter is stopped, everything
 * is torn down cleanly.
 */
export class DeepgramAdapter implements STTAdapter {
  onUtterance?: (utterance: Utterance) => void;
  onError?: (message: string) => void;
  onLevel?: (level: number) => void;

  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private running = false;
  private stopped = false;
  private muted = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInterimText = '';
  private lastFinalText = '';
  private lastLevelReport = 0;

  // Liveness watchdog: the server sends stt:keepalive frames every 10s. If we
  // stop hearing from the server while the socket still LOOKS open (Railway
  // restart, half-open connection, proxy hang), captions would silently stop
  // forever. Force a reconnect cycle instead.
  private lastServerMsgAt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private readonly WATCHDOG_STALE_MS = 45000;
  private micErrorShown = false;

  // Deepgram is configured (client + server) for linear16 @ 16000 Hz.
  // Browsers default to 44.1/48 kHz, so unless we force the context rate or
  // resample, the upstream gets 2.76-3x too many samples/sec and Deepgram
  // hears chipmunk-speed garbage -> SpeechStarted fires, transcripts are
  // empty. captureRatio = nativeRate / 16000 (1 when the context honors it).
  private captureRatio = 1;
  private resampleAcc = 0;

  // Audio batching: the AudioWorklet fires ~125 frames/sec at 16 kHz (128
  // samples = 8 ms). Sending each frame as its own WebSocket message floods
  // the proxy with tiny frames and adds jitter to the upstream stream.
  // Accumulate PCM16 and flush in ~50 ms blocks (800 samples @ 16 kHz).
  private pcmChunks: Int16Array[] = [];
  private pcmLen = 0;
  private readonly PCM_FLUSH_SAMPLES = 800;

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
    this.stopWatchdog();
    this.teardownMedia();
    // Ship any buffered tail audio upstream before closing the session so
    // Deepgram can finalize the last utterance.
    this.flushPcm();
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

  /**
   * Mute/unmute the STT capture without tearing down the socket or the
   * Deepgram session. While muted, audio frames are dropped before being
   * sent upstream, so nothing is transcribed or counted. Unmuting resumes
   * the same session (no reconnect churn).
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.onLevel?.(0);
      // Drop any audio captured before the mute — it should not be
      // transcribed after the user muted.
      this.pcmChunks = [];
      this.pcmLen = 0;
      // ScriptProcessor path: stop pulling audio while muted to save CPU.
      // (Worklet path: the muted guard in handlePcm already drops frames.)
      if (this.processor) this.processor.onaudioprocess = null;
    } else if (this.processor && this.audioContext) {
      this.processor.onaudioprocess = (e) => this.handleAudio(e);
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
      this.lastServerMsgAt = Date.now();
      this.startWatchdog();
      // The server ignores Configure messages entirely (the upstream URL
      // params are authoritative for model/encoding/sample_rate — v2 Flux
      // would even reject v1-style Configure fields with an Error event).
      // Sent for compatibility; harmless.
      this.ws?.send(
        JSON.stringify({
          type: 'Configure',
          encoding: 'linear16',
          sample_rate: 16000,
          channels: 1,
          interim_results: true,
          vad_events: true,
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

  /**
   * Watchdog: while the adapter is running, if no server frame (results,
   * keepalive, anything) arrives for WATCHDOG_STALE_MS, the socket is
   * presumed dead — close it so onclose -> scheduleReconnect re-establishes
   * the session. The server's 10s keepalive means a healthy session never
   * trips this; only genuinely stuck connections do.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (this.stopped || !this.running) return;
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastServerMsgAt > this.WATCHDOG_STALE_MS) {
        console.warn(`[DeepgramAdapter] no server frames for ${this.WATCHDOG_STALE_MS}ms — forcing reconnect`);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    }, 10000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * Emit a final turn text exactly once. Flux can fire EagerEndOfTurn and a
   * refined EndOfTurn for the same turn; if the turn was RESUMED, the final
   * is an extension of the eager text. Emitting both would double count
   * every word in the games/recap. Strategy:
   *   - identical text          -> already counted, skip
   *   - final extends the eager text (shared word prefix) -> emit only the
   *     NEW tail words
   *   - full rewrite / new turn -> emit everything
   */
  private emitFinalTurnText(text: string, confidence?: number): void {
    if (!text) return;
    const last = this.lastFinalText;
    this.lastFinalText = text;
    if (!last) {
      this.onUtterance?.({ speakerId: 'local', text, timestamp: Date.now(), isFinal: true, confidence });
      return;
    }
    const strip = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9'\s-]/g, ' ').trim().split(/\s+/).filter(Boolean);
    const prev = strip(last);
    const curr = strip(text);
    if (prev.join(' ') === curr.join(' ')) return; // exact duplicate
    let i = 0;
    while (i < prev.length && i < curr.length && prev[i] === curr[i]) i++;
    if (i > 0 && i < curr.length) {
      // Resumed turn: eager already counted the shared prefix — emit the tail.
      const tail = curr.slice(i).join(' ');
      this.onUtterance?.({ speakerId: 'local', text: tail, timestamp: Date.now(), isFinal: true, confidence });
      return;
    }
    if (i > 0 && i === curr.length) return; // new text is a prefix of last — fully counted
    this.onUtterance?.({ speakerId: 'local', text, timestamp: Date.now(), isFinal: true, confidence });
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    // Any parseable server frame counts as liveness for the watchdog.
    this.lastServerMsgAt = Date.now();

    if (msg.type === 'Error') {
      console.warn('[DeepgramAdapter] server error:', msg.message);
      // The server closes the socket after most Error frames; be defensive
      // and force the reconnect ourselves if it didn't.
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      return;
    }

    // ---- v2 Flux: turn-based events (StartOfTurn / Update / EndOfTurn) ----
    if (msg.type === 'TurnInfo' || typeof msg.event === 'string') {
      const event = msg.event ?? msg.type;
      const text = (msg.transcript ?? '').trim();
      if (event === 'StartOfTurn') {
        // Fresh turn: forget the previous turn's snapshots.
        this.lastInterimText = '';
        this.lastFinalText = '';
        return;
      }
      if (event === 'TurnResumed') {
        // Eager end-of-turn was cancelled — the speaker kept going. Live
        // interims resume (reset lastInterimText) but KEEP lastFinalText so
        // the eventual EndOfTurn can be diffed against the eager snapshot
        // and only the NEW tail words get counted.
        this.lastInterimText = '';
        return;
      }
      if (event === 'EndOfTurn' || event === 'EagerEndOfTurn') {
        // Keep lastInterimText equal to this turn's text: Deepgram sends a
        // trailing Update with the same text right after EOT, which would
        // otherwise re-show the caption as live after it finalized.
        this.lastInterimText = text;
        this.emitFinalTurnText(text, msg.end_of_turn_confidence as number | undefined);
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
      const bySpeaker = new Map<number, { words: string[]; confs: number[] }>();
      for (const w of alt.words ?? []) {
        const spk = typeof w.speaker === 'number' ? w.speaker : 0;
        if (!bySpeaker.has(spk)) bySpeaker.set(spk, { words: [], confs: [] });
        const entry = bySpeaker.get(spk)!;
        entry.words.push(w.word);
        if (typeof w.confidence === 'number') entry.confs.push(w.confidence);
      }
      for (const [spk, entry] of bySpeaker) {
        const text = entry.words.join(' ').trim();
        if (!text) continue;
        const confidence = entry.confs.length
          ? entry.confs.reduce((a, b) => a + b, 0) / entry.confs.length
          : undefined;
        this.onUtterance?.({
          speakerId: `speaker-${spk}`,
          text,
          timestamp: Date.now(),
          isFinal: true,
          confidence,
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
        confidence: typeof alt.confidence === 'number' ? alt.confidence : undefined,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Microphone capture -> PCM16 @ 16kHz mono -> socket
  // -------------------------------------------------------------------------

  private async startMicrophone(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.micErrorShown = false;
    } catch (err) {
      console.error('[DeepgramAdapter] getUserMedia failed:', err);
      if (!this.micErrorShown) {
        this.micErrorShown = true;
        this.onError?.(
          'Microphone blocked — allow mic access in the browser (or site settings) and toggle transcription off/on.',
        );
      }
      // Don't leave a half-dead session: retry the whole flow (WS + mic)
      // with backoff so a transient mic failure (device busy, permission
      // prompt dismissed by accident) self-heals instead of killing
      // captions for the rest of the call.
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      return;
    }

    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    try {
      // Ask the browser to resample the mic to 16 kHz natively. Not all
      // engines honor AudioContextOptions.sampleRate, hence the resampler
      // safety net in handlePcm/handleAudio using this.captureRatio.
      this.audioContext = new Ctx({ sampleRate: 16000 } as AudioContextOptions);
    } catch {
      this.audioContext = new Ctx();
    }
    this.captureRatio = this.audioContext.sampleRate / 16000;
    this.resampleAcc = 0;
    this.ensureContextRunning();

    this.source = this.audioContext.createMediaStreamSource(this.stream);

    try {
      // AudioWorklet: modern replacement for ScriptProcessorNode (which is
      // deprecated and logs a Chrome warning). Runs the PCM conversion on a
      // dedicated audio thread; the main thread just ships buffers to the WS.
      await this.setupWorklet(this.audioContext);
    } catch (err) {
      console.warn('[DeepgramAdapter] AudioWorklet unavailable, falling back to ScriptProcessorNode:', err);
      this.setupScriptProcessor(this.audioContext);
    }
  }

  /**
   * Chrome autoplay policy: an AudioContext created OUTSIDE a user gesture
   * starts in the 'suspended' state. A suspended context fires ZERO audio
   * callbacks, so no PCM ever reaches Deepgram even though the WS session
   * looks connected (Metadata arrives, captions never do). getUserMedia is
   * async, so the gesture that triggered the mic prompt has usually expired
   * by the time we get here. Resume now, retry every 500ms until running, and
   * resume on any user click/keypress — the user is actively clicking the UI.
   */
  private ensureContextRunning(): void {
    if (!this.audioContext) return;
    const tryResume = () => {
      if (this.audioContext?.state === 'suspended') {
        void this.audioContext.resume().catch(() => undefined);
      }
    };
    tryResume();
    const iv = setInterval(() => {
      if (!this.audioContext || this.audioContext.state === 'running') {
        clearInterval(iv);
      } else {
        tryResume();
      }
    }, 500);
    window.addEventListener('pointerdown', tryResume);
    window.addEventListener('keydown', tryResume);
    // Cleanup listeners when the adapter stops; interval self-cleans once running.
    const cleanup = () => {
      clearInterval(iv);
      window.removeEventListener('pointerdown', tryResume);
      window.removeEventListener('keydown', tryResume);
    };
    const onStop = () => cleanup();
    // Hook into stop(): store cleanup so stop() can call it.
    (this as any).__resumeCleanup = onStop;
  }

  private async setupWorklet(ctx: AudioContext): Promise<void> {
    const workletCode = `
      class PcmBridgeProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (input && input[0]) {
            const channel = input[0];
            const buf = new Float32Array(channel.length);
            buf.set(channel);
            this.port.postMessage(buf, [buf.buffer]);
          }
          return true;
        }
      }
      registerProcessor('pcm-bridge', PcmBridgeProcessor);
    `;
    const url = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.workletNode = new AudioWorkletNode(ctx, 'pcm-bridge', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    this.workletNode.port.onmessage = (e) => this.handlePcm(e.data as Float32Array);
    this.source?.connect(this.workletNode);
  }

  private setupScriptProcessor(ctx: AudioContext): void {
    this.processor = ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => this.handleAudio(e);
    this.source?.connect(this.processor);
    this.processor.connect(ctx.destination);
  }

  /**
   * Resample a native-rate Float32 chunk down to 16 kHz using linear
   * interpolation (good enough for speech), keeping the fractional sample
   * position across chunks so the stream stays continuous.
   */
  private to16k(input: Float32Array): Float32Array {
    if (this.captureRatio <= 1) return input;
    const n = input.length;
    const outLen = Math.floor((this.resampleAcc + n) / this.captureRatio);
    if (outLen <= 0) {
      this.resampleAcc += n;
      return new Float32Array(0);
    }
    const out = new Float32Array(outLen);
    let i = this.resampleAcc;
    let oi = 0;
    while (i < n && oi < outLen) {
      const i0 = Math.floor(i);
      const i1 = Math.min(i0 + 1, n - 1);
      const frac = i - i0;
      out[oi++] = input[i0] * (1 - frac) + input[i1] * frac;
      i += this.captureRatio;
    }
    this.resampleAcc = i - n;
    return oi === outLen ? out : out.subarray(0, oi);
  }

  /** Batch PCM16 and ship it upstream in ~50 ms blocks. */
  private pushPcm(pcm: Int16Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.pcmChunks.push(pcm);
    this.pcmLen += pcm.length;
    if (this.pcmLen >= this.PCM_FLUSH_SAMPLES) this.flushPcm();
  }

  private flushPcm(): void {
    if (this.pcmLen === 0) return;
    const chunks = this.pcmChunks;
    const total = this.pcmLen;
    this.pcmChunks = [];
    this.pcmLen = 0;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const buf = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.length;
    }
    this.ws.send(buf.buffer);
  }

  /** Convert a Float32 audio buffer to PCM16 and send it upstream. */
  private handleAudio(e: AudioProcessingEvent): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.muted) return;
    const input = e.inputBuffer.getChannelData(0); // Float32 [-1, 1]
    const resampled = this.to16k(input);
    if (resampled.length === 0) return;
    const pcm = new Int16Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) {
      const s = Math.max(-1, Math.min(1, resampled[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.pushPcm(pcm);
    this.reportLevel(input);
  }

  /** Float32 chunk from the AudioWorklet — convert to PCM16 and send. */
  private handlePcm(input: Float32Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.muted) return;
    const resampled = this.to16k(input);
    if (resampled.length === 0) return;
    const pcm = new Int16Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) {
      const s = Math.max(-1, Math.min(1, resampled[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.pushPcm(pcm);
    this.reportLevel(input);
  }

  /** Throttled RMS-ish level (0..1) so the UI can show live mic input. */
  private reportLevel(input: Float32Array): void {
    const now = Date.now();
    if (now - this.lastLevelReport < 120) return;
    this.lastLevelReport = now;
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    this.onLevel?.(Math.min(1, rms * 8));
  }

  private teardownMedia(): void {
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        /* ignore */
      }
      this.workletNode = null;
    }
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
    this.captureRatio = 1;
    this.resampleAcc = 0;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    // Detach the resume retry loop / gesture listeners.
    const cleanup = (this as any).__resumeCleanup;
    if (typeof cleanup === 'function') {
      cleanup();
      (this as any).__resumeCleanup = undefined;
    }
  }
}
