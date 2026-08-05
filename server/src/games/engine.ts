import * as db from '../db/queries.js';
import { channelManager } from '../ws/channels.js';
import type { LeaderboardEntry } from '../ws/messages.js';
import { makeWhoSaidThatRound, scoreWhoSaidThat, type WhoSaidThatRound } from './whoSaidThat.js';
import { buildScrabbleRound, type ScrabbleRound } from './scrabble.js';
import { selectTargetWord, countOccurrences, calculateBetScore, type WordCountBetRound } from './wordCountBet.js';
import type { UtteranceInfo } from './qualityGate.js';

const ROUND_TIME_LIMITS: Record<string, number> = {
  who_said_that: 30,
  scrabble: 45,
  word_count_bet: 60,
};

const ROUND_COOLDOWN_MS = 15_000;
const MIN_UTTERANCES_FOR_ROUND = 8;
const MAX_BUFFER_SIZE = 200;

const GAME_TYPES = ['who_said_that', 'scrabble', 'word_count_bet'] as const;
type GameType = (typeof GAME_TYPES)[number];

interface ActiveRound {
  id: string;
  gameType: GameType;
  state: 'open';
  roundData: any;
  timeLimitSec: number;
  startedAt: number;
  endTimer: NodeJS.Timeout;
  submitted: Set<string>;
  // For word count: utterances since round start
  roundUtterances: UtteranceInfo[];
}

export class RoomGameEngine {
  roomId: string;
  buffer: UtteranceInfo[] = [];
  currentRound: ActiveRound | null = null;
  roundCount = 0;
  lastRoundEndedAt = 0;

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  addUtterance(utterance: UtteranceInfo): void {
    this.buffer.push(utterance);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_SIZE);
    }

    // If word_count_bet round is active, add to round buffer
    if (this.currentRound?.gameType === 'word_count_bet') {
      this.currentRound.roundUtterances.push(utterance);
    }

    this.maybeStartRound();
  }

  private maybeStartRound(): void {
    if (this.currentRound) return;
    const now = Date.now();
    if (now - this.lastRoundEndedAt < ROUND_COOLDOWN_MS) return;
    if (this.buffer.length < MIN_UTTERANCES_FOR_ROUND) return;

    this.startNextRound();
  }

  private async startNextRound(): Promise<void> {
    const gameType = GAME_TYPES[this.roundCount % GAME_TYPES.length] as GameType;
    this.roundCount++;

    // Build round data
    let roundData: any;
    try {
      const participants = await db.getParticipantsByRoom(this.roomId);
      const pBriefs = participants.map((p: any) => ({ id: p.id, name: p.name }));

      switch (gameType) {
        case 'who_said_that': {
          const result = makeWhoSaidThatRound(this.buffer, pBriefs);
          if (!result) {
            // Couldn't build a round — push to next cycle
            return;
          }
          roundData = result;
          break;
        }
        case 'scrabble':
          roundData = buildScrabbleRound(this.buffer);
          break;
        case 'word_count_bet': {
          const targetWord = selectTargetWord(this.buffer);
          const initialCount = countOccurrences(targetWord, this.buffer);
          roundData = { targetWord, initialCount };
          break;
        }
      }
    } catch (e) {
      console.error(`[engine:${this.roomId}] Failed to build round:`, e);
      return;
    }

    const timeLimitSec = ROUND_TIME_LIMITS[gameType] ?? 30;
    const startedAt = Date.now();

    // Persist to DB
    let roundRecord: any;
    try {
      roundRecord = await db.createGameRound({
        roomId: this.roomId,
        gameType,
        roundData,
      });
    } catch (e) {
      console.error(`[engine:${this.roomId}] Failed to persist round:`, e);
      return;
    }

    // Set lock timer
    const endTimer = setTimeout(() => {
      this.lockRound(roundRecord.id);
    }, timeLimitSec * 1000);

    this.currentRound = {
      id: roundRecord.id,
      gameType,
      state: 'open',
      roundData,
      timeLimitSec,
      startedAt,
      endTimer,
      submitted: new Set(),
      roundUtterances: [],
    };

    // Broadcast round open
    channelManager.broadcast(this.roomId, {
      type: 'game:round:open',
      payload: {
        roundId: roundRecord.id,
        gameType,
        question: roundData,
        timeLimit: timeLimitSec,
      },
    });
  }

  async submitAnswer(roundId: string, participantId: string, answer: unknown): Promise<void> {
    if (!this.currentRound || this.currentRound.id !== roundId) return;
    if (this.currentRound.state !== 'open') return;
    if (this.currentRound.submitted.has(participantId)) return; // idempotent

    this.currentRound.submitted.add(participantId);

    try {
      // Insert with placeholder score; real score computed in scoreRound
      await db.saveGameSubmission({
        roundId,
        participantId,
        submission: answer,
        score: 0,
      });
    } catch (e: any) {
      // UNIQUE constraint violation — already submitted (ignore)
      if (!e.constraint?.includes('unique')) {
        console.error(`[engine:${this.roomId}] submit error:`, e);
      }
    }
  }

  private async lockRound(roundId: string): Promise<void> {
    if (!this.currentRound || this.currentRound.id !== roundId) return;

    // Clear timer
    clearTimeout(this.currentRound.endTimer);

    // Update DB
    try {
      await db.updateGameRound(roundId, { state: 'locked', ended_at: new Date().toISOString() });
    } catch (e) {
      console.error(`[engine:${this.roomId}] lock error:`, e);
    }

    // Broadcast locked
    channelManager.broadcast(this.roomId, {
      type: 'game:round:locked',
      payload: { roundId },
    });

    // Score immediately
    await this.scoreRound(roundId);
  }

  private async scoreRound(roundId: string): Promise<void> {
    if (!this.currentRound) return;
    const cr = this.currentRound;

    try {
      const roundData = cr.roundData;
      const participants = await db.getParticipantsByRoom(this.roomId);
      const subs = await db.getGameSubmissions(roundId);

      // For word count bet: compute actual count from round utterances + buffer
      let actualCount = 0;
      if (cr.gameType === 'word_count_bet') {
        actualCount = countOccurrences((roundData as WordCountBetRound).targetWord, cr.roundUtterances);
        (roundData as WordCountBetRound).actualCount = actualCount;
        // Update DB with actual count
        await db.updateGameRound(roundId, { round_data: JSON.stringify(roundData) });
      }

      // Compute scores for all submissions
      for (const sub of subs) {
        let score = 0;
        switch (cr.gameType) {
          case 'who_said_that': {
            const wstRound = roundData as WhoSaidThatRound;
            const correct = (sub.submission as { answer: string }).answer === wstRound.speakerId;
            // Use a rough estimate: assume they took half the time
            score = scoreWhoSaidThat(correct, cr.timeLimitSec * 500, cr.timeLimitSec * 1000);
            break;
          }
          case 'scrabble': {
            const scrRound = roundData as ScrabbleRound;
            const allWordSubs = subs
              .filter((s: any) => s.participant_id !== sub.participant_id)
              .map((s: any) => s.submission as { words: string[] });
            // Need to compute scores with cross-submission uniqueness
            const { points } = calculateScrabbleScore(
              (sub.submission as { words: string[] }).words,
              scrRound.bank,
              allWordSubs
            );
            score = points;
            break;
          }
          case 'word_count_bet': {
            score = calculateBetScore(
              (sub.submission as { guess: number }).guess,
              actualCount
            );
            break;
          }
        }

        await db.saveGameSubmission({
          roundId,
          participantId: sub.participant_id,
          submission: sub.submission,
          score,
        });
      }

      // Late-joiner fairness for word_count_bet: assign par bets
      if (cr.gameType === 'word_count_bet') {
        await this.assignParBets(roundId, cr, participants, actualCount);
      }

      // Build leaderboard
      const leaderboard = await this.buildLeaderboard();

      // Fetch updated submissions (with par bets)
      const updatedSubs = await db.getGameSubmissions(roundId);

      // Sanitize results for broadcast (remove internal data)
      const results = updatedSubs.map((s: any) => ({
        participantId: s.participant_id,
        participantName: s.participant_name,
        submission: s.submission,
        score: s.score,
      }));

      // Broadcast scored
      channelManager.broadcast(this.roomId, {
        type: 'game:round:scored',
        payload: { roundId, results, leaderboard },
      });
    } catch (e) {
      console.error(`[engine:${this.roomId}] score error:`, e);
    }

    // Reset current round
    this.currentRound = null;
    this.lastRoundEndedAt = Date.now();
  }

  private async assignParBets(
    roundId: string,
    cr: ActiveRound,
    participants: any[],
    actualCount: number
  ): Promise<void> {
    const subs = await db.getGameSubmissions(roundId);
    const submittedIds = new Set(subs.map((s: any) => s.participant_id));
    const roundStartedAt = cr.startedAt;

    // Compute average guess from actual submissions
    const actualGuesses = subs
      .map((s: any) => (s.submission as { guess: number }).guess)
      .filter((g: number) => typeof g === 'number');

    let parGuess = 0;
    if (actualGuesses.length > 0) {
      parGuess = Math.floor(
        actualGuesses.reduce((a: number, b: number) => a + b, 0) / actualGuesses.length
      );
    }

    // Assign par bets to late joiners who missed the round (joined after round started)
    for (const p of participants) {
      const joinedAt = new Date(p.joined_at).getTime();
      if (joinedAt > roundStartedAt && !submittedIds.has(p.id)) {
        const parScore = calculateBetScore(parGuess, actualCount);
        await db.saveGameSubmission({
          roundId,
          participantId: p.id,
          submission: { guess: parGuess, par: true },
          score: parScore,
        });
      }
    }
  }

  async buildLeaderboard(): Promise<LeaderboardEntry[]> {
    try {
      const rounds = await db.getGameRounds(this.roomId);
      const participants = await db.getParticipantsByRoom(this.roomId);
      const scoredRounds = rounds.filter((r: any) => r.state === 'scored' || r.state === 'locked');

      const totals = new Map<string, { total: number; roundsPlayed: number; name: string }>();

      for (const p of participants as any[]) {
        totals.set(p.id, { total: 0, roundsPlayed: 0, name: p.name });
      }

      for (const r of scoredRounds) {
        const subs = await db.getGameSubmissions(r.id);
        for (const s of subs as any[]) {
          const entry = totals.get(s.participant_id);
          if (entry) {
            entry.total += s.score ?? 0;
            const subData = s.submission as any;
            // Count par bets as participation too (they got a fair score)
            if (!subData?.par || s.score > 0) {
              entry.roundsPlayed++;
            }
          }
        }
      }

      const entries: LeaderboardEntry[] = Array.from(totals.entries())
        .filter(([_, v]) => v.roundsPlayed > 0)
        .map(([id, v]) => ({
          participantId: id,
          participantName: v.name,
          score: v.total,
          pointsPerRound: v.roundsPlayed > 0 ? Math.round((v.total / v.roundsPlayed) * 100) / 100 : 0,
          roundsPlayed: v.roundsPlayed,
        }))
        .sort((a, b) => {
          // Sort by pointsPerRound DESC, then total DESC
          const ppr = b.pointsPerRound - a.pointsPerRound;
          return ppr !== 0 ? ppr : b.score - a.score;
        });

      return entries;
    } catch (e) {
      console.error(`[engine:${this.roomId}] leaderboard error:`, e);
      return [];
    }
  }

  async getActiveRoundSnapshot(): Promise<{
    roundId: string;
    gameType: string;
    state: string;
    roundData: unknown;
    timeLimit: number;
    startedAt: string;
  } | null> {
    if (!this.currentRound) return null;
    return {
      roundId: this.currentRound.id,
      gameType: this.currentRound.gameType,
      state: this.currentRound.state,
      roundData: this.currentRound.roundData,
      timeLimit: this.currentRound.timeLimitSec,
      startedAt: new Date(this.currentRound.startedAt).toISOString(),
    };
  }

  async disconnect(): Promise<void> {
    if (this.currentRound) {
      clearTimeout(this.currentRound.endTimer);
    }
    this.buffer = [];
    this.currentRound = null;
  }
}

// Keep engines in memory per room
const engineMap = new Map<string, RoomGameEngine>();

export function getGameEngine(roomId: string): RoomGameEngine {
  let engine = engineMap.get(roomId);
  if (!engine) {
    engine = new RoomGameEngine(roomId);
    engineMap.set(roomId, engine);
  }
  return engine;
}

export function destroyGameEngine(roomId: string): void {
  const engine = engineMap.get(roomId);
  if (engine) {
    engine.disconnect();
    engineMap.delete(roomId);
  }
}

// Helper: calculate Scrabble score accounting for uniqueness across submissions
function calculateScrabbleScore(
  words: string[],
  bank: string[],
  otherSubmissions: Array<{ words: string[] }>
): { points: number } {
  const uniqueWords = new Set(words.map((w) => w.toLowerCase().trim()));
  let totalPoints = 0;

  for (const w of uniqueWords) {
    if (!bank.includes(w)) continue;
    const isUnique = !otherSubmissions.some(
      (s) => s.words.some((sw) => sw.toLowerCase().trim() === w)
    );
    totalPoints += 100 + (isUnique ? 500 : 0);
  }
  return { points: totalPoints };
}