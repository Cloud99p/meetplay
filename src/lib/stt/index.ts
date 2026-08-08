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
 *                                                    diarized, via the server
 *                                                    proxy — key stays server-side)
 *
 * Deepgram mode needs NO client-side key: the browser streams audio to the
 * same-origin /api/stt proxy, and the server holds DEEPGRAM_API_KEY. If the
 * server lacks the key it replies with an Error message and the adapter logs
 * it gracefully. All adapters share the STTAdapter contract, so the game
 * engine treats them identically.
 */
export function createSttAdapter(localParticipantId?: string): STTAdapter {
  const mode = (import.meta.env.VITE_STT_MODE ?? 'deepgram').toLowerCase();

  switch (mode) {
    case 'deepgram':
    default:
      // Deepgram is the production default (Live streaming + diarization via
      // the server-side /api/stt proxy — key never ships to the browser).
      // Only explicit VITE_STT_MODE=mock/webspeech overrides it.
      return new DeepgramAdapter();
    case 'webspeech':
      return new WebSpeechAdapter();
    case 'mock':
      return new MockAdapter(localParticipantId);
  }
}
