import { useEffect, useRef, useState, useCallback } from 'react';
import { createSttAdapter } from '../lib/stt';
import type { STTAdapter } from '../lib/stt/STTAdapter';

interface UseSttOptions {
  enabled: boolean;          // transcription toggled on
  connected: boolean;        // WS connected
  localParticipantId?: string;
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
export function useStt({ enabled, connected, localParticipantId, sendCaption }: UseSttOptions): UseSttResult {
  const adapterRef = useRef<STTAdapter | null>(null);
  const [sttEnabled, setSttEnabled] = useState(false);

  const sendCaptionRef = useRef(sendCaption);
  sendCaptionRef.current = sendCaption;

  const startAdapter = useCallback(() => {
    if (adapterRef.current) return;
    const adapter = createSttAdapter(localParticipantId);
    adapter.onUtterance = (utterance) => {
      sendCaptionRef.current(utterance.speakerId, utterance.text, utterance.isFinal);
    };
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

  return { sttEnabled, paused: enabled && !connected };
}
