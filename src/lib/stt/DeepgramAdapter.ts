import type { STTAdapter, Utterance } from './STTAdapter';

/**
 * Production STT adapter using Deepgram's Live API over WebSocket.
 *
 * - Streaming speech-to-text with speaker diarization (REQUIRED for the
 *   "Who Said That?" game).
 * - Uses the browser's microphone (getUserMedia) -> PCM16 @ 16kHz mono ->
 *   Deepgram Live endpoint.
 * - Browser-safe auth: Deepgram supports passing the API key as the `token`
 *   query param because the browser WebSocket API cannot set headers.
 * - Graceful degradation: if the socket fails or closes unexpectedly, we
 *   reconnect with exponential backoff. If the adapter is stopped, everything
 *   is torn down cleanly.
 *
 * Env:
 *   VITE_DEEPGRAM_API_KEY  (required for this adapter; key is embedded in the
 *                           WS URL, so it ships to the client bundle — fine for
 *                           an MVP/app where the client calls Deepgram directly;
 *                           for stricter security, proxy through your server)
 */
export class DeepgramAdapter implements STTAdapter {
  onUtterance?: (utterance: Utterance) => void;

  private apiKey: string;
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private running = false;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? import.meta.env.VITE_DEEPGRAM_API_KEY ?? '';
    if (!this.apiKey) {
      console.warn('[DeepgramAdapter] No VITE_DEEPGRAM_API_KEY set. Adapter will not start.');
    }
  }

  start(): void {
    if (this.running || !this.apiKey) return;
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
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  // -------------------------------------------------------------------------
  // Deepgram socket
  // -------------------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;

    const params = new URLSearchParams({
      model: 'nova-2',
      diarize: 'true',
      interim_results: 'true',
      punctuate: 'true',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      token: this.apiKey,
    });

    try {
      this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`);
    } catch (err) {
      console.error('[DeepgramAdapter] Failed to open WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
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
      // Downmix (already mono) + convert to 16-bit PCM little-endian
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
