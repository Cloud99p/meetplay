import * as db from '../db/queries.js';
import { channelManager } from '../ws/channels.js';
import type { LeaderboardEntry } from '../ws/messages.js';
import { makeWhoSaidThatRound, scoreWhoSaidThat, type WhoSaidThatRound } from './whoSaidThat.js';
import { buildScrabbleRound, type ScrabbleRound } from './scrabble.js';
import { selectTargetWord, calculateBetScore, type WordCountBetRound } from './wordCountBet.js';
import { computeGuessOdds, oddsMultiplier, countWordInText, type MarketBet } from './market.js';
import {
  buildBingoCard, matchingCardIndices, findBingoLine, BINGO_SIZE,
} from './bingo.js';
import { updateSpeakerStats, buildStatRows, type SpeakerStats } from './stats.js';
import { buildQuizQuestions, type QuizQuestion } from './quiz.js';
import type { UtteranceInfo } from './qualityGate.js';

const ROUND_TIME_LIMITS: Record<string, number> = {
  who_said_that: 30,
  scrabble: 45,
};

const ROUND_COOLDOWN_MS = 15_000;
const MIN_UTTERANCES_FOR_ROUND = 8;
const MAX_BUFFER_SIZE = 200;

// Quick rotating rounds (Layer B). Word Count Bet is no longer a round —
// it lives as an always-on market (Layer A) in this same engine.
const GAME_TYPES = ['who_said_that', 'scrabble'] as const;
type GameType = (typeof GAME_TYPES)[number];

const BINGO_WIN_SCORE = 1500;
const BINGO_NEXT_ROUND_DELAY_MS = 12_000;
const STATS_BROADCAST_INTERVAL_MS = 3_000;
const MARKET_UPDATE_THROTTLE_MS = 1_500;

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

interface MarketState {
  roundId: string;
  targetWord: string;
  startedAt: number;
  liveCount: number;
  bets: Map<string, MarketBet>;
  resolved: boolean;
  lastBroadcast: number;
}

interface BingoState {
  roundId: string;
  roundNumber: number;
  cards: Map<string, string[]>; // participantId -> 25 words
  marks: Map<string, Set<number>>; // participantId -> marked indices
  winner: { participantId: string; participantName: string } | null;
  nextTimer: NodeJS.Timeout | null;
}

// Guards against double-finalization when endMeetingRoom runs in parallel
// (WS room:end + HTTP fallback are both idempotent callers).
const quizSavedRooms = new Set<string>();

export class RoomGameEngine {
  roomId: string;
  buffer: UtteranceInfo[] = [];
  currentRound: ActiveRound | null = null;
  roundCount = 0;
  lastRoundEndedAt = 0;

  // Layer A — always-on passive games
  market: MarketState | null = null;
  bingo: BingoState | null = null;
  speakerStats: Map<string, SpeakerStats> = new Map();
  private statsDirty = false;
  private statsTimer: NodeJS.Timeout | null = null;
  private nameById: Map<string, string> = new Map();

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  /** Refresh the participant name cache (used for bingo/stats/market broadcasts). */
  async refreshNames(): Promise<void> {
    try {
      const participants = await db.getParticipantsByRoom(this.roomId);
      this.nameById = new Map(participants.map((p: any) => [p.id, p.name]));
    } catch {
      // keep stale cache
    }
  }

  /**
   * Start the always-on passive games when the call starts (called on WS
   * connect). Opens the Word Count market immediately if the room name has
   * a usable word; otherwise it opens after the first few utterances.
   */
  async startPassiveGames(roomName: string | null): Promise<void> {
    await this.refreshNames();
    if (!this.market) {
      const seed = this.pickRoomNameWord(roomName);
      if (seed) await this.openMarket(seed);
    }
    if (!this.bingo) {
      await this.openBingoRound(1);
    }
    this.ensureStatsTimer();
  }

  /** Pick a content word from the room name, or null if none usable. */
  private pickRoomNameWord(roomName: string | null): string | null {
    if (!roomName) return null;
    const tokens = roomName
      .toLowerCase()
      .replace(/[^a-z0-9'-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && /[a-z]/.test(w));
    return tokens[0] ?? null;
  }

  addUtterance(utterance: UtteranceInfo): void {
    this.buffer.push(utterance);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_SIZE);
    }

    this.nameById.set(utterance.speakerId, this.nameById.get(utterance.speakerId) ?? utterance.speakerId);

    // ── Layer A: market live count ──
    if (this.market && !this.market.resolved) {
      const hits = countWordInText(this.market.targetWord, utterance.text);
      if (hits > 0) {
        this.market.liveCount += hits;
        this.broadcastMarketUpdate(true /* throttled */);
      }
    }

    // ── Layer A: bingo auto-marking ──
    this.markBingo(utterance);

    // ── Layer A: stats ──
    updateSpeakerStats(this.speakerStats, utterance.speakerId, utterance.text);
    this.statsDirty = true;

    // ── Layer B: quick rounds ──
    this.maybeStartRound();

    // ── Market fallback seed: once we have a bit of speech ──
    if (!this.market && this.buffer.length >= 3) {
      const word = selectTargetWord(this.buffer);
      if (word && word !== 'meeting') {
        this.openMarket(word);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Word Count Bet market (Layer A)
  // ──────────────────────────────────────────────────────────────

  private async openMarket(targetWord: string): Promise<void> {
    if (this.market) return;
    try {
      const roundRecord = await db.createGameRound({
        roomId: this.roomId,
        gameType: 'word_count_bet',
        roundData: { targetWord, initialCount: 0 } as WordCountBetRound,
      });
      this.market = {
        roundId: roundRecord.id,
        targetWord,
        startedAt: Date.now(),
        liveCount: 0,
        bets: new Map(),
        resolved: false,
        lastBroadcast: 0,
      };
      channelManager.broadcast(this.roomId, {
        type: 'game:market:open',
        payload: { roundId: roundRecord.id, targetWord, startedAt: new Date(this.market.startedAt).toISOString() },
      });
      console.log(`[engine:${this.roomId}] WCB market opened on "${targetWord}"`);
    } catch (e) {
      console.error(`[engine:${this.roomId}] openMarket error:`, e);
    }
  }

  /** Place/update a market bet. Locks odds at current market state. */
  async submitMarketBet(roundId: string, participantId: string, participantName: string, answer: unknown): Promise<void> {
    if (!this.market || this.market.resolved || this.market.roundId !== roundId) return;
    // Answer arrives as { guess: number } (same shape as the old WCB round)
    const raw = (answer as { guess?: unknown } | null)?.guess ?? answer;
    const g = Number(raw);
    if (!Number.isFinite(g) || g < 0 || g > 9999) return;

    // Lock odds using the CURRENT market (before this bet is added), so a
    // player's own bet doesn't tank their price.
    const currentOdds = computeGuessOdds(Array.from(this.market.bets.values()), this.market.liveCount);
    const lockedOdds = currentOdds[String(g)] ?? 1.01;

    this.market.bets.set(participantId, {
      participantId,
      guess: g,
      lockedOdds,
      submittedAt: Date.now(),
    });

    try {
      await db.saveGameSubmission({
        roundId,
        participantId,
        submission: { guess: g, lockedOdds },
        score: 0, // real score computed at resolution
      });
    } catch (e) {
      console.error(`[engine:${this.roomId}] market bet save error:`, e);
    }

    // Announce the bet + refresh odds for everyone
    channelManager.broadcast(this.roomId, {
      type: 'game:market:bet',
      payload: {
        roundId,
        participantId,
        participantName,
        guess: g,
        lockedOdds,
        liveCount: this.market.liveCount,
      },
    });
    this.broadcastMarketUpdate(false);
  }

  /** Broadcast current live count + odds (throttled for count ticks). */
  private broadcastMarketUpdate(throttled: boolean): void {
    if (!this.market || this.market.resolved) return;
    const now = Date.now();
    if (throttled && now - this.market.lastBroadcast < MARKET_UPDATE_THROTTLE_MS) return;
    this.market.lastBroadcast = now;
    const odds = computeGuessOdds(Array.from(this.market.bets.values()), this.market.liveCount);
    channelManager.broadcast(this.roomId, {
      type: 'game:market:update',
      payload: {
        roundId: this.market.roundId,
        targetWord: this.market.targetWord,
        liveCount: this.market.liveCount,
        odds,
      },
    });
  }

  /**
   * Resolve the market at meeting end. Idempotent.
   * Scores every bet as closeness × oddsMultiplier(lockedOdds), persists the
   * results, and broadcasts the resolution before the room closes.
   */
  async resolveMarket(): Promise<void> {
    if (!this.market || this.market.resolved) return;
    const m = this.market;
    m.resolved = true;
    const actualCount = m.liveCount;
    const roundData: WordCountBetRound = { targetWord: m.targetWord, initialCount: 0, actualCount };
    await db.updateGameRound(m.roundId, {
      state: 'scored',
      ended_at: new Date().toISOString(),
      // Pass the object — memory DB stores as-is, pg stringifies on insert
      round_data: roundData,
    });

    const results: Array<{ participantId: string; participantName: string; submission: unknown; score: number }> = [];
    for (const bet of m.bets.values()) {
      const score = Math.round(calculateBetScore(bet.guess, actualCount) * oddsMultiplier(bet.lockedOdds));
      await db.saveGameSubmission({
        roundId: m.roundId,
        participantId: bet.participantId,
        submission: { guess: bet.guess, lockedOdds: bet.lockedOdds },
        score,
      });
      results.push({
        participantId: bet.participantId,
        participantName: this.nameById.get(bet.participantId) ?? 'Unknown',
        submission: { guess: bet.guess },
        score,
      });
    }

    const leaderboard = await this.buildLeaderboard();
    channelManager.broadcast(this.roomId, {
      type: 'game:market:resolved',
      payload: {
        roundId: m.roundId,
        targetWord: m.targetWord,
        actualCount,
        results,
        leaderboard,
      },
    });
    console.log(`[engine:${this.roomId}] WCB market resolved: "${m.targetWord}" = ${actualCount}`);
  }

  getMarketSnapshot(): {
    roundId: string;
    targetWord: string;
    startedAt: string;
    liveCount: number;
    odds: Record<string, number>;
    myBet: { guess: number; lockedOdds: number } | null;
    resolved: boolean;
    actualCount?: number;
  } | null {
    if (!this.market) return null;
    const m = this.market;
    return {
      roundId: m.roundId,
      targetWord: m.targetWord,
      startedAt: new Date(m.startedAt).toISOString(),
      liveCount: m.liveCount,
      odds: computeGuessOdds(Array.from(m.bets.values()), m.liveCount),
      myBet: null, // per-participant, filled by caller
      resolved: m.resolved,
      actualCount: m.resolved ? m.liveCount : undefined,
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Buzzword Bingo (Layer A)
  // ──────────────────────────────────────────────────────────────

  private async openBingoRound(roundNumber: number): Promise<void> {
    if (this.bingo?.nextTimer) {
      clearTimeout(this.bingo.nextTimer);
    }
    try {
      const participants = await db.getParticipantsByRoom(this.roomId);
      const roundRecord = await db.createGameRound({
        roomId: this.roomId,
        gameType: 'bingo',
        roundData: { roundNumber, cardSize: BINGO_SIZE },
      });
      const cards = new Map<string, string[]>();
      for (const p of participants as any[]) {
        cards.set(p.id, buildBingoCard(this.roomId, p.id, roundNumber));
      }
      this.bingo = {
        roundId: roundRecord.id,
        roundNumber,
        cards,
        marks: new Map(),
        winner: null,
        nextTimer: null,
      };
      channelManager.broadcast(this.roomId, {
        type: 'bingo:open',
        payload: { roundId: roundRecord.id, roundNumber },
      });
      console.log(`[engine:${this.roomId}] Bingo round ${roundNumber} opened`);
    } catch (e) {
      console.error(`[engine:${this.roomId}] openBingoRound error:`, e);
    }
  }

  private markBingo(utterance: UtteranceInfo): void {
    if (!this.bingo || this.bingo.winner) return;
    const b = this.bingo;
    const card = b.cards.get(utterance.speakerId);
    if (!card) return;

    const hits = matchingCardIndices(utterance.text, card);
    if (hits.length === 0) return;

    let marks = b.marks.get(utterance.speakerId);
    if (!marks) {
      marks = new Set();
      b.marks.set(utterance.speakerId, marks);
    }
    const newHits = hits.filter((i) => !marks!.has(i));
    if (newHits.length === 0) return;
    newHits.forEach((i) => marks!.add(i));

    // Private update so each player only sees their own card fill up
    channelManager.sendTo(this.roomId, utterance.speakerId, {
      type: 'bingo:mark',
      payload: { roundId: b.roundId, indices: newHits },
    });

    const line = findBingoLine(marks);
    if (line) {
      b.winner = { participantId: utterance.speakerId, participantName: this.nameById.get(utterance.speakerId) ?? 'Unknown' };
      // Persist the win as a submission so it shows on the leaderboard/recap
      db.saveGameSubmission({
        roundId: b.roundId,
        participantId: utterance.speakerId,
        submission: { line: line.type, indices: line.indices, roundNumber: b.roundNumber },
        score: BINGO_WIN_SCORE,
      }).catch(() => {});
      db.updateGameRound(b.roundId, { state: 'scored', ended_at: new Date().toISOString() }).catch(() => {});
      channelManager.broadcast(this.roomId, {
        type: 'bingo:win',
        payload: {
          roundId: b.roundId,
          roundNumber: b.roundNumber,
          participantId: b.winner.participantId,
          participantName: b.winner.participantName,
          lineType: line.type,
        },
      });
      // Deal a new card after a beat
      b.nextTimer = setTimeout(() => {
        this.openBingoRound(b.roundNumber + 1);
      }, BINGO_NEXT_ROUND_DELAY_MS);
    }
  }

  getBingoSnapshot(participantId: string): {
    roundId: string;
    roundNumber: number;
    myCard: string[];
    myMarks: number[];
    winner: { participantId: string; participantName: string } | null;
  } | null {
    if (!this.bingo) return null;
    const b = this.bingo;
    return {
      roundId: b.roundId,
      roundNumber: b.roundNumber,
      myCard: b.cards.get(participantId) ?? [],
      myMarks: Array.from(b.marks.get(participantId) ?? []).sort((a, c) => a - c),
      winner: b.winner,
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Stats (Layer A)
  // ──────────────────────────────────────────────────────────────

  private ensureStatsTimer(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      if (!this.statsDirty) return;
      this.statsDirty = false;
      const rows = buildStatRows(this.speakerStats, this.nameById);
      channelManager.broadcast(this.roomId, {
        type: 'stats:update',
        payload: { stats: rows },
      });
    }, STATS_BROADCAST_INTERVAL_MS);
  }

  getStatsSnapshot() {
    return buildStatRows(this.speakerStats, this.nameById);
  }

  // ──────────────────────────────────────────────────────────────
  // Recap quiz (generated at meeting end)
  // ──────────────────────────────────────────────────────────────

  /**
   * Generate the "did you actually listen?" quiz from the in-memory buffer
   * and persist it as a recap_quiz game round. Idempotent across the WS +
   * HTTP parallel end paths (module-level guard).
   */
  async saveRecapQuiz(): Promise<void> {
    if (quizSavedRooms.has(this.roomId)) return;
    quizSavedRooms.add(this.roomId);
    try {
      const room = await db.getRoomById(this.roomId);
      const participants = await db.getParticipantsByRoom(this.roomId);
      if (!room) return;
      const durationSec = Math.max(0, Math.floor((Date.now() - new Date(room.created_at).getTime()) / 1000));
      const questions: QuizQuestion[] = buildQuizQuestions({
        utterances: this.buffer,
        participants: participants.map((p: any) => ({ id: p.id, name: p.name })),
        durationSec,
        marketTargetWord: this.market?.targetWord,
        marketActualCount: this.market?.resolved ? this.market.liveCount : undefined,
      });
      if (questions.length < 3) return; // not enough signal — skip
      const roundRecord = await db.createGameRound({
        roomId: this.roomId,
        gameType: 'recap_quiz',
        roundData: { questions },
      });
      await db.updateGameRound(roundRecord.id, { state: 'scored', ended_at: new Date().toISOString() });
      console.log(`[engine:${this.roomId}] Recap quiz saved (${questions.length} questions)`);
    } catch (e) {
      console.error(`[engine:${this.roomId}] saveRecapQuiz error:`, e);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Quick rounds (Layer B) — unchanged behavior, WCB removed
  // ──────────────────────────────────────────────────────────────

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

  async submitAnswer(roundId: string, participantId: string, participantName: string, answer: unknown): Promise<void> {
    // Route to the market if this roundId is the live market
    if (this.market && this.market.roundId === roundId) {
      return this.submitMarketBet(roundId, participantId, participantName, answer);
    }
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
      const subs = await db.getGameSubmissions(roundId);

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
        }

        await db.saveGameSubmission({
          roundId,
          participantId: sub.participant_id,
          submission: sub.submission,
          score,
        });
      }

      // Build leaderboard
      const leaderboard = await this.buildLeaderboard();

      // Fetch updated submissions
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
    if (this.bingo?.nextTimer) {
      clearTimeout(this.bingo.nextTimer);
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.buffer = [];
    this.currentRound = null;
    this.bingo = null;
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
