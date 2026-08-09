import type { STTAdapter, Utterance } from './STTAdapter';

/**
 * Production STT adapter using the Web Speech API (browser-native, no API key).
 * Note: does not provide speaker diarization — all speech attributed to a single speakerId.
 */
export class WebSpeechAdapter implements STTAdapter {
  onUtterance?: (utterance: Utterance) => void;
  private recognition: SpeechRecognition | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      console.warn('[WebSpeechAdapter] SpeechRecognition not available');
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      if (this.muted) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        this.onUtterance?.({
          speakerId: 'local',
          text: result[0].transcript,
          timestamp: Date.now(),
          isFinal: result.isFinal,
        });
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.warn('[WebSpeechAdapter] error:', event.error);
    };

    // SpeechRecognition stops on its own after silence / most errors
    // ('no-speech', 'aborted', 'network'). Without an onend restart, captions
    // die mid-call and never come back — same bug class as the Deepgram
    // adapter. Restart unless we were deliberately stopped/muted.
    recognition.onend = () => {
      if (!this.running || this.muted) return;
      try {
        recognition.start();
      } catch {
        /* already started or closing — next onend will retry */
      }
    };

    recognition.start();
    this.recognition = recognition;
    this.running = true;
  }

  stop(): void {
    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
    }
    this.running = false;
  }

  /** Mute/unmute WebSpeech recognition (pauses transcription). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted && this.recognition) {
      this.recognition.stop();
    } else if (!muted && this.running && !this.recognition) {
      this.start();
    }
  }

  private muted = false;
}