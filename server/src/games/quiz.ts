// Recap quiz — auto-generated "did you actually listen?" questions.
//
// Built at meeting end from the in-memory utterance buffer (so it works even
// though transcript events are deleted when the room ends). Stored as a
// game round with gameType 'recap_quiz' and rendered on the recap page.

import type { UtteranceInfo } from './qualityGate.js';

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'i', 'you', 'he', 'she',
  'it', 'we', 'they', 'this', 'that', 'these', 'those', 'not', 'no',
  'nor', 'so', 'ok', 'yeah', 'hi', 'hello', 'hey', 'like', 'well',
  'right', 'okay', 'oh', 'ah', 'um', 'uh', 'hmm', 'got', 'get', 'let',
  'going', 'gonna', 'really', 'actually', 'just', 'very', 'also', 'us',
  'them', 'me', 'my', 'your', 'our', 'their',
]);

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function wordCount(text: string): number {
  return text.replace(/[^a-z0-9'-]/g, ' ').split(/\s+/).filter(Boolean).length;
}

/** Frequency of content words across utterances (excluding a skip word). */
function wordFrequencies(utterances: UtteranceInfo[], skipWord?: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const u of utterances) {
    const tokens = u.text
      .toLowerCase()
      .replace(/[^a-z0-9'-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && /[a-z]/.test(w));
    for (const t of tokens) {
      if (skipWord && t.includes(skipWord)) continue;
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  return freq;
}

export interface QuizContext {
  utterances: UtteranceInfo[];
  participants: Array<{ id: string; name: string }>;
  durationSec: number;
  marketTargetWord?: string;
  marketActualCount?: number;
}

export function buildQuizQuestions(ctx: QuizContext): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  const { utterances, participants, durationSec } = ctx;
  const names = participants.map((p) => p.name);

  // ── Q1: Who said this? ──────────────────────────────────────────────
  if (names.length >= 2) {
    const quotable = utterances.filter((u) => wordCount(u.text) >= 8);
    const speakerSet = new Map(participants.map((p) => [p.id, p.name]));
    const withKnownSpeaker = quotable.filter((u) => speakerSet.has(u.speakerId));
    if (withKnownSpeaker.length > 0) {
      const pick = withKnownSpeaker[Math.floor(Math.random() * withKnownSpeaker.length)];
      const correctName = speakerSet.get(pick.speakerId)!;
      const others = shuffle(names.filter((n) => n !== correctName));
      const options = shuffle([correctName, ...others.slice(0, Math.min(3, others.length))]);
      questions.push({
        id: 'who_said',
        prompt: `Who said: "${pick.text}"?`,
        options,
        correctIndex: options.indexOf(correctName),
        explanation: `${correctName} said it during the meeting.`,
      });
    }
  }

  // ── Q2: Most-used word ──────────────────────────────────────────────
  const freq = wordFrequencies(utterances, ctx.marketTargetWord);
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length >= 4) {
    const [topWord, topCount] = sorted[0];
    const decoys = shuffle(sorted.slice(1, 8)).slice(0, 3).map(([w]) => w);
    const options = shuffle([topWord, ...decoys]);
    questions.push({
      id: 'most_used',
      prompt: `Which word was said the most (${topCount} times)?`,
      options,
      correctIndex: options.indexOf(topWord),
      explanation: `"${topWord}" came up ${topCount} times.`,
    });
  }

  // ── Q3: Word count market result ────────────────────────────────────
  if (ctx.marketTargetWord && ctx.marketActualCount !== undefined) {
    const actual = ctx.marketActualCount;
    const offsets = shuffle([0, 1, -1, 2, -2, 4, -4, 8, -8]).slice(0, 3);
    const options = shuffle([actual, ...offsets.map((o) => Math.max(0, actual + o))]);
    questions.push({
      id: 'word_count',
      prompt: `How many times did someone say "${ctx.marketTargetWord}"?`,
      options: options.map(String),
      correctIndex: options.indexOf(actual),
      explanation: `The final count was ${actual}.`,
    });
  }

  // ── Q4: Duration ────────────────────────────────────────────────────
  if (durationSec >= 45) {
    const minutes = Math.max(1, Math.round(durationSec / 60));
    const decoys = shuffle([minutes + 2, minutes - 2, minutes + 5, minutes - 5, minutes + 10])
      .filter((m) => m >= 1)
      .slice(0, 3);
    const options = shuffle([minutes, ...decoys]);
    questions.push({
      id: 'duration',
      prompt: 'How long did the meeting last?',
      options: options.map((m) => (m === 1 ? '1 minute' : `${m} minutes`)),
      correctIndex: options.indexOf(minutes),
      explanation: `The meeting ran for ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    });
  }

  // ── Q5: Participants ────────────────────────────────────────────────
  if (participants.length >= 2) {
    const n = participants.length;
    const decoys = shuffle([n + 1, n - 1, n + 2, n - 2, n + 3]).filter((m) => m >= 1).slice(0, 3);
    const options = shuffle([n, ...decoys]);
    questions.push({
      id: 'participants',
      prompt: 'How many people joined this meeting?',
      options: options.map(String),
      correctIndex: options.indexOf(n),
      explanation: `${n} people joined.`,
    });
  }

  return questions;
}
