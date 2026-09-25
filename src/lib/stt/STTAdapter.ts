export interface Utterance {
  speakerId: string;
  text: string;
  timestamp: number;
  isFinal: boolean;
  /** 0..1 transcription confidence (flux: end_of_turn_confidence; v1: avg word confidence). */
  confidence?: number;
  /**
   * The FULL text of the turn this emission belongs to, whenever that is not
   * the same as `text` — or when the caller needs the turn's wording rather
   * than this emission's delta.
   *
   * Word counting MUST keep using `text`: on a resumed Flux turn `text` is only
   * the new tail words, so the shared prefix is counted exactly once. `turnText`
   * exists so DISPLAY surfaces can put the sentence back together
   * ("we should ship" + "it friday" -> one line, not two).
   *
   * Absent on adapters that never re-emit a turn (mock, webspeech, and the v1
   * diarized Results path), where `text` is already the whole utterance.
   */
  turnText?: string;
  /**
   * Identity of the turn this emission belongs to. Two emissions that share a
   * `turnSeq` for one speaker are the SAME sentence growing; a different
   * `turnSeq` is a new sentence, even when it starts with the same words.
   *
   * This is the fact display cannot reconstruct from text alone: an interim
   * re-states a turn in full while a refined final carries only its tail, so
   * "continues the previous line" and "happens to repeat its opening words"
   * look identical. Absent on the paths listed on `turnText`.
   */
  turnSeq?: number;
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