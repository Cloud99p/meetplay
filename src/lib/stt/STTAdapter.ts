export interface Utterance {
  speakerId: string;
  text: string;
  timestamp: number;
  isFinal: boolean;
}

export interface STTAdapter {
  onUtterance?: (utterance: Utterance) => void;
  start(): void;
  stop(): void;
  /**
   * Pause/resume audio capture WITHOUT tearing down the adapter or the WS
   * session. When muted, no audio is sent upstream, so no words are
   * transcribed/counted until unmuted. This is what makes the ControlBar mic
   * button actually mute the app's listening (STT has its own getUserMedia
   * stream, separate from the LiveKit mic).
   */
  setMuted(muted: boolean): void;
}