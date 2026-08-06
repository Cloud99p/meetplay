import { MockAdapter } from './MockAdapter';
import { WebSpeechAdapter } from './WebSpeechAdapter';
import { DeepgramAdapter } from './DeepgramAdapter';
import type { STTAdapter } from './STTAdapter';

/**
 * STT adapter factory.
 *
 * Selects the speech-to-text backend at runtime via VITE_STT_MODE:
 *
 *   VITE_STT_MODE=mock        -> MockAdapter        (default; buildathon/demo,
 *                                                    deterministic script, no keys)
 *   VITE_STT_MODE=webspeech   -> WebSpeechAdapter   (browser-native STT, free,
 *                                                    NO speaker diarization)
 *   VITE_STT_MODE=deepgram    -> DeepgramAdapter    (production: streaming,
 *                                                    diarized; requires
 *                                                    VITE_DEEPGRAM_API_KEY)
 *
 * If `deepgram` is requested but no API key is configured, we fall back to the
 * mock adapter so the app never breaks in a demo. The game engine treats all
 * adapters the same because they share the STTAdapter contract.
 */
export function createSttAdapter(localParticipantId?: string): STTAdapter {
  const mode = (import.meta.env.VITE_STT_MODE ?? 'mock').toLowerCase();

  switch (mode) {
    case 'deepgram': {
      const key = import.meta.env.VITE_DEEPGRAM_API_KEY ?? '';
      if (!key) {
        console.warn('[stt] VITE_STT_MODE=deepgram but VITE_DEEPGRAM_API_KEY is missing — falling back to mock.');
        return new MockAdapter(localParticipantId);
      }
      return new DeepgramAdapter(key);
    }
    case 'webspeech':
      return new WebSpeechAdapter();
    case 'mock':
    default:
      return new MockAdapter(localParticipantId);
  }
}
