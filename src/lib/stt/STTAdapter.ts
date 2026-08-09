export interface Utterance {
  speakerId: string;
  text: string;
  timestamp: number;
  isFinal: boolean;
  /** 0..1 transcription confidence (flux: end_of_turn_confidence; v1: avg word confidence). */
  confidence?: number;
}

export interface STTAdapter {
  onUtterance?: (utterance: Utterance) => void;
  /** Called when the adapter hits a user-actionable failure (e.g. mic
   *  permission denied). Lets the UI surface why nothing is being
   *  transcribed instead of failing silently. */
  onError?: (message: string) => void;
  /** Live mic input level (0..1), throttled to ~10/sec. Lets the UI show a
   *  level meter so users can SEE that audio is actually reaching the app
   *  (a silent AudioContext produces zero frames). */
  onLevel?: (level: number) => void;
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