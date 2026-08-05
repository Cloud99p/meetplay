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
}