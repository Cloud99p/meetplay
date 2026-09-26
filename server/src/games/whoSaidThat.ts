import type { UtteranceInfo } from './qualityGate.js';
import { validateQuote } from './qualityGate.js';
import { resolveTurnText } from '../stt/turnText.js';

export interface WhoSaidThatRound {
  quote: string;
  speakerId: string;
  options: Array<{ id: string; name: string }>;
}

export interface ParticipantBrief {
  id: string;
  name: string;
}

/**
 * Select a quote and build 4 options (1 correct + 3 random from participants).
 */
export function makeWhoSaidThatRound(
  utterances: UtteranceInfo[],
  participants: ParticipantBrief[]
): WhoSaidThatRound | null {
  // Find a valid quote. validateQuote() keeps reading `text` (the countable
  // payload) — only the wording that is SHOWN is spelled out in full below.
  const valid = utterances.filter((u) => validateQuote(u, utterances).pass);
  if (valid.length === 0) return null;

  // Pick a random valid utterance
  const pick = valid[Math.floor(Math.random() * valid.length)];

  // Find the speaker
  const correctSpeaker = participants.find((p) => p.id === pick.speakerId);
  if (!correctSpeaker) return null;

  // Build options: 1 correct + 3 decoys
  const decoys = participants
    .filter((p) => p.id !== pick.speakerId)
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);

  const options = [
    { id: correctSpeaker.id, name: correctSpeaker.name },
    ...decoys.map((p) => ({ id: p.id, name: p.name })),
  ].sort(() => Math.random() - 0.5);

  return {
    // The turn's verified wording, not just the tail fragment the buffer holds
    // ("it friday"): a resumed turn must not be quoted alone.
    quote: resolveTurnText(utterances, pick),
    speakerId: pick.speakerId,
    options,
  };
}

/**
 * Score a Who Said That answer.
 * @param correct Whether the answer matches the speaker
 * @param timeRemainingMs Time remaining when answered (0 if timed out)
 * @param timeLimitMs Total time limit
 */
export function scoreWhoSaidThat(
  correct: boolean,
  timeRemainingMs: number,
  timeLimitMs: number
): number {
  if (!correct) return 0;
  const fraction = Math.max(0, timeRemainingMs / timeLimitMs);
  return Math.round(500 + 500 * fraction);
}

/**
 * Score a submission and return the result.
 * @param submission The player's answer
 * @param roundData The round data with the correct speaker
 * @param timeRemainingMs Time remaining when the round was scored
 * @param timeLimitMs Total time limit
 */
export function scoreWhoSaidThatSubmission(
  submission: { answer: string },
  roundData: WhoSaidThatRound,
  timeRemainingMs: number,
  timeLimitMs: number
): number {
  const correct = submission.answer === roundData.speakerId;
  return scoreWhoSaidThat(correct, Math.max(0, timeRemainingMs), timeLimitMs);
}