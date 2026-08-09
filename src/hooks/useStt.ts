import { useEffect, useRef, useState, useCallback } from 'react';
import { createSttAdapter } from '../lib/stt';
import type { STTAdapter } from '../lib/stt/STTAdapter';

interface UseSttOptions {
  enabled: boolean;          // transcription toggled on
  connected: boolean;        // WS connected
  localParticipantId?: string;
  /** Mirrors the ControlBar mic button: true = user muted the mic. When true,
   *  the adapter pauses audio capture so nothing is transcribed (STT has its
   *  own getUserMedia stream, separate from the LiveKit mic). */
  muted?: boolean;
  /** Called when the STT adapter hits a user-actionable failure (mic
   *  permission denied, etc.) so the UI can show why nothing is being
   *  transcribed. */
  onError?: (message: string) => void;
  /** Live mic input level (0..1), throttled to ~10/sec — powers the mic
   *  level meter so users can SEE audio reaching the app. */
  onLevel?: (level: number) => void;
  sendCaption: (speakerId: string, text: string, isFinal: boolean) => void;
}

interface UseSttResult {
  sttEnabled: boolean;
  paused: boolean;
}

/**
 * Owns the STT adapter lifecycle: starts the configured STT adapter (mock,
 * webspeech, or deepgram — see VITE_STT_MODE) when transcription is enabled
 * AND the room is connected; stops it otherwise. Wires utterances to the
 * server via caption:event.
 */
export function useStt({ enabled, connected, localParticipantId, muted, onError, onLevel, sendCaption }: UseSttOptions): UseSttResult {
  const adapterRef = useRef<STTAdapter | null>(null);
  const [sttEnabled, setSttEnabled] = useState(false);

  const sendCaptionRef = useRef(sendCaption);
  sendCaptionRef.current = sendCaption;

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;

  const startAdapter = useCallback(() => {
    if (adapterRef.current) return;
    const adapter = createSttAdapter(localParticipantId);
    adapter.onUtterance = (utterance) => {
      sendCaptionRef.current(utterance.speakerId, utterance.text, utterance.isFinal);
    };
    adapter.onError = (message) => {
      console.warn('[useStt] adapter error:', message);
      onErrorRef.current?.(message);
    };
    adapter.onLevel = (level) => onLevelRef.current?.(level);
    adapter.start();
    adapterRef.current = adapter;
    setSttEnabled(true);
  }, [localParticipantId]);

  const stopAdapter = useCallback(() => {
    if (adapterRef.current) {
      adapterRef.current.stop();
      adapterRef.current = null;
    }
    setSttEnabled(false);
  }, []);

  useEffect(() => {
    // Start the adapter when transcription is enabled. Deliberately do NOT
    // tear it down when `connected` flickers (room WS reconnect, Railway
    // restart, etc.): the adapter has its own reconnect/backoff, and stopping
    // it mid-handshake makes the browser throw "WebSocket is closed before
    // the connection is established". Captions queue locally while the room
    // WS is down and flush on reconnect (sendCaption handles that).
    if (enabled) {
      startAdapter();
    } else {
      stopAdapter();
    }
    return () => stopAdapter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, startAdapter, stopAdapter]);

  // Mirror the mic button state into the adapter (pause capture when muted).
  useEffect(() => {
    adapterRef.current?.setMuted(muted ?? false);
  }, [muted]);

  return { sttEnabled, paused: enabled && !connected };
}
