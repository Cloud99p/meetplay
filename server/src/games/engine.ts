import * as db from '../db/queries.js';
import { channelManager } from '../ws/channels.js';
import type { LeaderboardEntry } from '../ws/messages.js';
import { makeWhoSaidThatRound, scoreWhoSaidThat, type WhoSaidThatRound } from './whoSaidThat.js';
import { buildScrabbleRound, calculateScore as calcScrabbleScore, type ScrabbleRound } from './scrabble.js';
import { selectTargetWord, calculateBetScore, type WordCountBetRound } from './wordCountBet.js';
import { computeGuessOdds, oddsMultiplier, countWordInText, type MarketBet } from './market.js';
import {
  buildBingoCard, matchingCardIndices, findBingoLine, BINGO_SIZE,
} from './bingo.js';
import { updateSpeakerStats, buildStatRows, type SpeakerStats } from './stats.js';
import { buildQuizQuestions, type QuizQuestion } from './quiz.js';
import type { UtteranceInfo } from './qualityGate.js';
import { omniClient } from '../intelligence/omniClient.js';

const ROUND_TIME_LIMITS: Record<string, number> = {
  who_said_that: 30,
  scrabble: 90,
};

const MIN_UTTERANCES_FOR_ROUND = 8;
const MAX_BUFFER_SIZE = 200;

// Player-chosen quick rounds. Rounds no longer auto-rotate mid-meeting —
// members pick from the game menu; only Flash WCB stays automatic.
type StartableGameType = 'who_said_that' | 'scrabble' | 'bingo';

const BINGO_WIN_SCORE = 1500;
const STATS_BROADCAST_INTERVAL_MS = 3_000;
const MARKET_UPDATE_THROTTLE_MS = 1_500;

// Flash WCB — random short-window word count bets that pop up mid-call.
// A word is picked (from live speech or a curated pool), a 60–120s window
// opens, players bet how many times it'll be said, then it resolves and
// the next flash is scheduled at a random interval.
const FLASH_WINDOW_MS_OPTIONS = [60_000, 90_000, 120_000];
const FLASH_FIRST_DELAY_MIN_MS = 20_000;
const FLASH_FIRST_DELAY_MAX_MS = 60_000;
const FLASH_NEXT_DELAY_MIN_MS = 30_000;
const FLASH_NEXT_DELAY_MAX_MS = 90_000;
const FLASH_WORD_POOL = [
  'roadmap', 'deadline', 'budget', 'client', 'update', 'review', 'agenda',
  'quarter', 'launch', 'feedback', 'sync', 'project', 'status', 'plan',
  'goal', 'issue', 'report', 'meeting', 'team', 'timeline', 'priority',
  'strategy', 'revenue', 'growth', 'product', 'design', 'engineer', 'test',
];

interface ActiveRound {
  id: string;
  gameType: 'who_said_that' | 'scrabble';
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

interface FlashState {
  roundId: string;
  targetWord: string;
  windowMs: number;
  startedAt: number;
  endsAt: number;
  liveCount: number;
  bets: Map<string, MarketBet>;
  resolved: boolean;
  lastBroadcast: number;
  endTimer: NodeJS.Timeout | null;
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
  flash: FlashState | null = null;
  speakerStats: Map<string, SpeakerStats> = new Map();
  // Member-created word bets (community markets) — keyed by lowercase word
  userMarkets: Map<string, {
    state: MarketState;
    createdBy: string;
    createdByName: string;
    endsAt?: number;
    endTimer?: NodeJS.Timeout | null;
  }> = new Map();
  private statsDirty = false;
  private statsTimer: NodeJS.Timeout | null = null;
  private nameById: Map<string, string> = new Map();

  private static MAX_USER_MARKETS = 5;
  // Allowed durations for member markets, in seconds (0 = call-long)
  static readonly USER_MARKET_DURATIONS = [0, 60, 120, 300, 600];

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
      // Bingo no longer auto-opens — players start it from the game menu.
    }
    this.ensureStatsTimer();
    // Schedule the first flash WCB at a random moment (20–60s in), then
    // each subsequent flash 30–90s after the previous one resolves.
    if (!this.flash?.nextTimer && !this.flash?.endTimer) {
      this.scheduleNextFlash(true);
    }
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

    const summary = `[engine:${this.roomId.slice(0, 8)}] addUtterance speaker=${utterance.speakerId} text="${utterance.text.slice(0, 120)}"`;
    const gameHits: string[] = [];

    // ── Layer A: market live count ──
    if (this.market && !this.market.resolved) {
      const hits = countWordInText(this.market.targetWord, utterance.text);
      if (hits > 0) {
        this.market.liveCount += hits;
        gameHits.push(`market("${this.market.targetWord}")+${hits}`);
        this.broadcastMarketUpdate(true /* throttled */);
      }
    }

    // ── Layer A: flash WCB live count (only within the window) ──
    if (this.flash && !this.flash.resolved && Date.now() <= this.flash.endsAt) {
      const hits = countWordInText(this.flash.targetWord, utterance.text);
      if (hits > 0) {
        this.flash.liveCount += hits;
        gameHits.push(`flash("${this.flash.targetWord}")+${hits}`);
        this.broadcastFlashUpdate(true /* throttled */);
      }
    }

    // ── Layer A: member-created word markets ──
    for (const um of this.userMarkets.values()) {
      if (um.state.resolved) continue;
      const hits = countWordInText(um.state.targetWord, utterance.text);
      if (hits > 0) {
        um.state.liveCount += hits;
        gameHits.push(`userMarket("${um.state.targetWord}")+${hits}`);
        this.broadcastUserMarketUpdate(um.state.targetWord, true /* throttled */);
      }
    }

    // ── Layer A: bingo auto-marking ──
    const bingoHits = this.markBingo(utterance);
    if (bingoHits > 0) gameHits.push(`bingo+${bingoHits}marks`);

    // ── Layer A: stats ──
    updateSpeakerStats(this.speakerStats, utterance.speakerId, utterance.text);
    this.statsDirty = true;

    console.log(gameHits.length > 0 ? `${summary} -> GAME HITS: ${gameHits.join(', ')}` : summary);

    // Note: rounds are now player-chosen (game:start); nothing auto-opens here.

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
  // Flash WCB (Layer A) — random short-window word count bets
  // ──────────────────────────────────────────────────────────────

  /** Schedule the next flash round after a random delay. */
  private scheduleNextFlash(first: boolean): void {
    const min = first ? FLASH_FIRST_DELAY_MIN_MS : FLASH_NEXT_DELAY_MIN_MS;
    const max = first ? FLASH_FIRST_DELAY_MAX_MS : FLASH_NEXT_DELAY_MAX_MS;
    const delay = min + Math.floor(Math.random() * (max - min));
    if (this.flash?.nextTimer) clearTimeout(this.flash.nextTimer);
    const timer = setTimeout(() => {
      this.openFlashRound();
    }, delay);
    if (this.flash) {
      this.flash.nextTimer = timer;
    } else {
      // Flash hasn't been created yet — keep a standalone timer on the engine
      (this as any)._flashNextTimer = timer;
    }
  }

  /** Pick a word for the flash round: live speech if available, else pool. */
  private pickFlashWord(): string {
    const spoken = selectTargetWord(this.buffer);
    const usable = spoken && spoken !== 'meeting' && spoken.length >= 3 && spoken !== this.market?.targetWord;
    if (usable && Math.random() < 0.7) return spoken;
    const pool = FLASH_WORD_POOL.filter((w) => w !== this.market?.targetWord);
    return pool[Math.floor(Math.random() * pool.length)] ?? 'roadmap';
  }

  /** Open a random flash WCB window (60–120s). */
  private async openFlashRound(): Promise<void> {
    // Only one flash at a time; never overlap with an open one
    if (this.flash && !this.flash.resolved) {
      this.scheduleNextFlash(false);
      return;
    }
    const windowMs = FLASH_WINDOW_MS_OPTIONS[Math.floor(Math.random() * FLASH_WINDOW_MS_OPTIONS.length)];
    const targetWord = this.pickFlashWord();
    try {
      const roundRecord = await db.createGameRound({
        roomId: this.roomId,
        gameType: 'flash_wcb',
        roundData: { targetWord, windowMs },
      });
      const now = Date.now();
      this.flash = {
        roundId: roundRecord.id,
        targetWord,
        windowMs,
        startedAt: now,
        endsAt: now + windowMs,
        liveCount: 0,
        bets: new Map(),
        resolved: false,
        lastBroadcast: 0,
        endTimer: null,
        nextTimer: null,
      };
      channelManager.broadcast(this.roomId, {
        type: 'game:flash:open',
        payload: {
          roundId: roundRecord.id,
          targetWord,
          windowMs,
          startedAt: new Date(now).toISOString(),
          endsAt: new Date(now + windowMs).toISOString(),
        },
      });
      console.log(`[engine:${this.roomId}] Flash WCB opened on "${targetWord}" (${Math.round(windowMs / 1000)}s window)`);
      this.flash.endTimer = setTimeout(() => {
        this.resolveFlashRound();
      }, windowMs);
    } catch (e) {
      console.error(`[engine:${this.roomId}] openFlashRound error:`, e);
      this.scheduleNextFlash(false);
    }
  }

  /** Place/update a flash bet. Locks odds at current market state. */
  async submitFlashBet(roundId: string, participantId: string, participantName: string, answer: unknown): Promise<void> {
    if (!this.flash || this.flash.resolved || this.flash.roundId !== roundId) return;
    const f = this.flash;
    const raw = (answer as { guess?: unknown } | null)?.guess ?? answer;
    const g = Number(raw);
    if (!Number.isFinite(g) || g < 0 || g > 9999) return;

    const currentOdds = computeGuessOdds(Array.from(f.bets.values()), f.liveCount);
    const lockedOdds = currentOdds[String(g)] ?? 1.01;
    f.bets.set(participantId, {
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
        score: 0,
      });
    } catch (e) {
      console.error(`[engine:${this.roomId}] flash bet save error:`, e);
    }

    channelManager.broadcast(this.roomId, {
      type: 'game:flash:bet',
      payload: {
        roundId,
        participantId,
        participantName,
        guess: g,
        lockedOdds,
        liveCount: f.liveCount,
      },
    });
    this.broadcastFlashUpdate(false);
  }

  /** Broadcast live count + odds + remaining time (throttled for count ticks). */
  private broadcastFlashUpdate(throttled: boolean): void {
    if (!this.flash || this.flash.resolved) return;
    const f = this.flash;
    const now = Date.now();
    if (throttled && now - f.lastBroadcast < MARKET_UPDATE_THROTTLE_MS) return;
    f.lastBroadcast = now;
    const odds = computeGuessOdds(Array.from(f.bets.values()), f.liveCount);
    channelManager.broadcast(this.roomId, {
      type: 'game:flash:update',
      payload: {
        roundId: f.roundId,
        targetWord: f.targetWord,
        liveCount: f.liveCount,
        odds,
        remainingMs: Math.max(0, f.endsAt - now),
      },
    });
  }

  /** Resolve the flash window: score bets, broadcast, schedule next. Idempotent. */
  async resolveFlashRound(): Promise<void> {
    if (!this.flash || this.flash.resolved) return;
    const f = this.flash;
    f.resolved = true;
    if (f.endTimer) clearTimeout(f.endTimer);
    const actualCount = f.liveCount;
    const roundData = { targetWord: f.targetWord, windowMs: f.windowMs, actualCount };
    await db.updateGameRound(f.roundId, {
      state: 'scored',
      ended_at: new Date().toISOString(),
      round_data: roundData,
    });

    const results: Array<{ participantId: string; participantName: string; submission: unknown; score: number }> = [];
    for (const bet of f.bets.values()) {
      const score = Math.round(calculateBetScore(bet.guess, actualCount) * oddsMultiplier(bet.lockedOdds));
      await db.saveGameSubmission({
        roundId: f.roundId,
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
      type: 'game:flash:resolved',
      payload: {
        roundId: f.roundId,
        targetWord: f.targetWord,
        windowMs: f.windowMs,
        actualCount,
        results,
        leaderboard,
      },
    });
    console.log(`[engine:${this.roomId}] Flash WCB resolved: "${f.targetWord}" = ${actualCount} (${Math.round(f.windowMs / 1000)}s)`);
    this.scheduleNextFlash(false);
  }

  getFlashSnapshot(participantId: string): {
    roundId: string;
    targetWord: string;
    windowMs: number;
    startedAt: string;
    endsAt: string;
    liveCount: number;
    odds: Record<string, number>;
    myBet: { guess: number; lockedOdds: number } | null;
    resolved: boolean;
    actualCount?: number;
  } | null {
    if (!this.flash) return null;
    const f = this.flash;
    const bet = f.bets.get(participantId);
    return {
      roundId: f.roundId,
      targetWord: f.targetWord,
      windowMs: f.windowMs,
      startedAt: new Date(f.startedAt).toISOString(),
      endsAt: new Date(f.endsAt).toISOString(),
      liveCount: f.liveCount,
      odds: computeGuessOdds(Array.from(f.bets.values()), f.liveCount),
      myBet: bet ? { guess: bet.guess, lockedOdds: bet.lockedOdds } : null,
      resolved: f.resolved,
      actualCount: f.resolved ? f.liveCount : undefined,
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Member-created word bets (Layer A) — community markets
  // ──────────────────────────────────────────────────────────────

  /**
   * A member opens a market on a word with their own guess. Anyone can then
   * bet on it. Validation is strict to keep the board clean.
   * Returns an error string, or null on success.
   */
  async createUserMarket(
    participantId: string,
    participantName: string,
    rawWord: unknown,
    rawGuess: unknown,
    rawDurationSec?: unknown
  ): Promise<string | null> {
    const word = String(rawWord ?? '').toLowerCase().trim();
    const guess = Number(rawGuess);
    if (!/^[a-z][a-z0-9'-]{1,19}$/.test(word)) {
      return 'Word must be 2–20 letters (letters, numbers, hyphens).';
    }
    if (!Number.isFinite(guess) || guess < 0 || guess > 9999) {
      return 'Guess must be a number between 0 and 9999.';
    }
    const durationSec = Number(rawDurationSec ?? 0);
    if (!RoomGameEngine.USER_MARKET_DURATIONS.includes(durationSec)) {
      return 'Duration must be call-long, 1, 2, 5 or 10 minutes.';
    }
    if (this.market?.targetWord === word) {
      return `"${word}" is already the main market word.`;
    }
    if (this.userMarkets.has(word)) {
      return `"${word}" already has a market — bet on it instead.`;
    }
    if (this.userMarkets.size >= RoomGameEngine.MAX_USER_MARKETS) {
      return `Max ${RoomGameEngine.MAX_USER_MARKETS} member markets reached.`;
    }
    try {
      const roundRecord = await db.createGameRound({
        roomId: this.roomId,
        gameType: 'user_word_bet',
        roundData: { targetWord: word, initialCount: 0, createdBy: participantName, durationSec },
      });
      const state: MarketState = {
        roundId: roundRecord.id,
        targetWord: word,
        startedAt: Date.now(),
        liveCount: 0,
        bets: new Map(),
        resolved: false,
        lastBroadcast: 0,
      };
      const entry: {
        state: MarketState;
        createdBy: string;
        createdByName: string;
        endsAt?: number;
        endTimer?: NodeJS.Timeout | null;
      } = { state, createdBy: participantId, createdByName: participantName };
      this.userMarkets.set(word, entry);
      // Optional time limit: resolve this market when the timer fires
      if (durationSec > 0) {
        entry.endsAt = Date.now() + durationSec * 1000;
        entry.endTimer = setTimeout(() => {
          this.resolveUserMarket(word);
        }, durationSec * 1000);
      }
      channelManager.broadcast(this.roomId, {
        type: 'game:userMarket:open',
        payload: {
          roundId: roundRecord.id,
          targetWord: word,
          createdBy: participantId,
          createdByName: participantName,
          startedAt: new Date(state.startedAt).toISOString(),
          durationSec,
          endsAt: entry.endsAt ? new Date(entry.endsAt).toISOString() : undefined,
        },
      });
      // Creator's own guess is auto-placed as their bet
      await this.submitUserMarketBet(word, participantId, participantName, { guess });
      console.log(`[engine:${this.roomId}] Member market opened on "${word}" by ${participantName}${durationSec > 0 ? ` (${durationSec}s)` : ' (call-long)'}`);
      return null;
    } catch (e) {
      console.error(`[engine:${this.roomId}] createUserMarket error:`, e);
      return 'Could not create market — try again.';
    }
  }

  /** Place/update a bet on a member market. */
  async submitUserMarketBet(
    wordOrRoundId: string,
    participantId: string,
    participantName: string,
    answer: unknown
  ): Promise<void> {
    // Look up by word or by round id
    let entry = this.userMarkets.get(wordOrRoundId);
    if (!entry) {
      entry = Array.from(this.userMarkets.values()).find((u) => u.state.roundId === wordOrRoundId);
    }
    if (!entry || entry.state.resolved) return;
    const m = entry.state;
    const raw = (answer as { guess?: unknown } | null)?.guess ?? answer;
    const g = Number(raw);
    if (!Number.isFinite(g) || g < 0 || g > 9999) return;

    const currentOdds = computeGuessOdds(Array.from(m.bets.values()), m.liveCount);
    const lockedOdds = currentOdds[String(g)] ?? 1.01;
    m.bets.set(participantId, {
      participantId,
      guess: g,
      lockedOdds,
      submittedAt: Date.now(),
    });
    try {
      await db.saveGameSubmission({
        roundId: m.roundId,
        participantId,
        submission: { guess: g, lockedOdds },
        score: 0,
      });
    } catch (e) {
      console.error(`[engine:${this.roomId}] user market bet save error:`, e);
    }
    channelManager.broadcast(this.roomId, {
      type: 'game:userMarket:bet',
      payload: {
        roundId: m.roundId,
        targetWord: m.targetWord,
        participantId,
        participantName,
        guess: g,
        lockedOdds,
        liveCount: m.liveCount,
      },
    });
    this.broadcastUserMarketUpdate(m.targetWord, false);
  }

  /** Broadcast live count + odds for one member market (throttled). */
  private broadcastUserMarketUpdate(word: string, throttled: boolean): void {
    const entry = this.userMarkets.get(word);
    if (!entry || entry.state.resolved) return;
    const m = entry.state;
    const now = Date.now();
    if (throttled && now - m.lastBroadcast < MARKET_UPDATE_THROTTLE_MS) return;
    m.lastBroadcast = now;
    const odds = computeGuessOdds(Array.from(m.bets.values()), m.liveCount);
    channelManager.broadcast(this.roomId, {
      type: 'game:userMarket:update',
      payload: {
        roundId: m.roundId,
        targetWord: m.targetWord,
        liveCount: m.liveCount,
        odds,
        remainingMs: entry.endsAt ? Math.max(0, entry.endsAt - now) : undefined,
      },
    });
  }

  /** Resolve a single member market (used by timed expiry). */
  async resolveUserMarket(word: string): Promise<void> {
    const entry = this.userMarkets.get(word);
    if (!entry || entry.state.resolved) return;
    if (entry.endTimer) {
      clearTimeout(entry.endTimer);
      entry.endTimer = null;
    }
    await this.finalizeUserMarket(entry);
  }

  /** Resolve all member markets at meeting end. Idempotent. */
  async resolveUserMarkets(): Promise<void> {
    for (const entry of this.userMarkets.values()) {
      if (entry.state.resolved) continue;
      if (entry.endTimer) {
        clearTimeout(entry.endTimer);
        entry.endTimer = null;
      }
      await this.finalizeUserMarket(entry);
    }
  }

  private async finalizeUserMarket(entry: {
    state: MarketState;
    createdBy: string;
    createdByName: string;
    endsAt?: number;
    endTimer?: NodeJS.Timeout | null;
  }): Promise<void> {
    const m = entry.state;
    if (m.resolved) return;
    m.resolved = true;
    const actualCount = m.liveCount;
    await db.updateGameRound(m.roundId, {
      state: 'scored',
      ended_at: new Date().toISOString(),
      round_data: {
        targetWord: m.targetWord,
        initialCount: 0,
        actualCount,
        createdBy: entry.createdByName,
        durationSec: entry.endsAt ? Math.round((entry.endsAt - m.startedAt) / 1000) : 0,
      },
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
      type: 'game:userMarket:resolved',
      payload: {
        roundId: m.roundId,
        targetWord: m.targetWord,
        actualCount,
        results,
        leaderboard,
      },
    });
    console.log(`[engine:${this.roomId}] Member market resolved: "${m.targetWord}" = ${actualCount}`);
  }

  getUserMarketsSnapshot(participantId: string): Array<{
    roundId: string;
    targetWord: string;
    createdBy: string;
    createdByName: string;
    startedAt: string;
    endsAt?: string;
    durationSec?: number;
    liveCount: number;
    odds: Record<string, number>;
    myBet: { guess: number; lockedOdds: number } | null;
    resolved: boolean;
    actualCount?: number;
  }> {
    const out: Array<{
      roundId: string;
      targetWord: string;
      createdBy: string;
      createdByName: string;
      startedAt: string;
      endsAt?: string;
      durationSec?: number;
      liveCount: number;
      odds: Record<string, number>;
      myBet: { guess: number; lockedOdds: number } | null;
      resolved: boolean;
      actualCount?: number;
    }> = [];
    for (const entry of this.userMarkets.values()) {
      const m = entry.state;
      const bet = m.bets.get(participantId);
      out.push({
        roundId: m.roundId,
        targetWord: m.targetWord,
        createdBy: entry.createdBy,
        createdByName: entry.createdByName,
        startedAt: new Date(m.startedAt).toISOString(),
        endsAt: entry.endsAt ? new Date(entry.endsAt).toISOString() : undefined,
        durationSec: entry.endsAt ? Math.round((entry.endsAt - m.startedAt) / 1000) : undefined,
        liveCount: m.liveCount,
        odds: computeGuessOdds(Array.from(m.bets.values()), m.liveCount),
        myBet: bet ? { guess: bet.guess, lockedOdds: bet.lockedOdds } : null,
        resolved: m.resolved,
        actualCount: m.resolved ? m.liveCount : undefined,
      });
    }
    return out;
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

  private markBingo(utterance: UtteranceInfo): number {
    if (!this.bingo || this.bingo.winner) return 0;
    const b = this.bingo;
    const card = b.cards.get(utterance.speakerId);
    if (!card) return 0;

    const hits = matchingCardIndices(utterance.text, card);
    if (hits.length === 0) return 0;

    let marks = b.marks.get(utterance.speakerId);
    if (!marks) {
      marks = new Set();
      b.marks.set(utterance.speakerId, marks);
    }
    const newHits = hits.filter((i) => !marks!.has(i));
    if (newHits.length === 0) return 0;
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
      // Deal a new card after a beat — NO: bingo rounds are now player-
      // started from the game menu. A win ends the current round; members
      // restart bingo when they want another card.
    }
    return newHits.length;
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
      // Draw the quiz from the graph-augmented pool so recap covers the whole
      // transcript, not just the bounded in-memory buffer.
      const augmented = await this.getGraphAugmentedPool();
      const questions: QuizQuestion[] = buildQuizQuestions({
        utterances: augmented,
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

  /**
   * Augmented utterance pool for recap/quiz generation: the full Omnilearn
   * graph for this meeting PLUS the live in-memory buffer. Lets recap draw on
   * the entire transcript, not just the tail of the bounded local buffer.
   */
  private async getGraphAugmentedPool(): Promise<UtteranceInfo[]> {
    try {
      const graph = await this.getGraphUtterances();
      return [...graph, ...this.buffer];
    } catch {
      return this.buffer.slice(0);
    }
  }

  /**
   * Fetch this room's utterances back from the Omnilearn graph as
   * UtteranceInfo with distinct synthetic timestamps (avoids the overlap
   * guard in validateQuote spuriously rejecting distinct lines). Returns []
   * on any failure (caller falls back to local).
   */
  private async getGraphUtterances(): Promise<UtteranceInfo[]> {
    try {
      const quotes = await omniClient.getQuotes(this.roomId, 60);
      if (quotes.length === 0) return [];
      return quotes.map((q, i) => ({
        speakerId: q.speakerId,
        text: q.text,
        timestamp: Date.now() - i * 1000,
      }));
    } catch (e) {
      console.error(`[engine:${this.roomId}] getGraphUtterances error:`, e);
      return [];
    }
  }

  /**
   * Player-chosen game start (game:start). Any member can start one game at
   * a time. Bingo opens immediately; who_said_that/scrabble need enough
   * conversation to build from. Returns a reason when rejected so the
   * requester can show it.
   */
  async startGame(
    gameType: StartableGameType,
    _participantId: string,
    _participantName: string
  ): Promise<{ ok: boolean; reason?: string }> {
    if (this.currentRound) {
      return { ok: false, reason: 'A round is already running — let it finish first.' };
    }
    if (gameType === 'bingo') {
      if (this.bingo && !this.bingo.winner) {
        return { ok: false, reason: 'Bingo is already in play.' };
      }
      await this.openBingoRound(this.bingo?.roundNumber ? this.bingo.roundNumber + 1 : 1);
      return { ok: true };
    }
    if (this.buffer.length < MIN_UTTERANCES_FOR_ROUND) {
      return { ok: false, reason: 'Not enough conversation yet — keep talking so the game has material.' };
    }
    const ok = await this.startNextRound(gameType);
    return ok
      ? { ok: true }
      : { ok: false, reason: 'Could not build that game from the conversation yet — try again in a moment.' };
  }

  /** Open a who_said_that / scrabble round now. Returns false if it can't be built. */
  private async startNextRound(gameType: 'who_said_that' | 'scrabble'): Promise<boolean> {
    // Build round data
    let roundData: any;
    try {
      const participants = await db.getParticipantsByRoom(this.roomId);
      const pBriefs = participants.map((p: any) => ({ id: p.id, name: p.name }));

      switch (gameType) {
        case 'who_said_that': {
          // Prefer quotes pulled back from the Omnilearn graph (they persist
          // even after the local buffer rolls over). Fall back through the
          // graph+local merge to the in-memory buffer, so a graph speaker
          // mismatch (e.g. synthetic mock ids) can never starve a round.
          const graph = await this.getGraphUtterances();
          const result =
            makeWhoSaidThatRound(graph, pBriefs) ??
            makeWhoSaidThatRound([...graph, ...this.buffer], pBriefs) ??
            makeWhoSaidThatRound(this.buffer, pBriefs);
          if (!result) {
            // Couldn't build a round
            return false;
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
      return false;
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
      return false;
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
    return true;
  }

  async submitAnswer(roundId: string, participantId: string, participantName: string, answer: unknown): Promise<void> {
    // Route to the market if this roundId is the live market
    if (this.market && this.market.roundId === roundId) {
      return this.submitMarketBet(roundId, participantId, participantName, answer);
    }
    // Route to the flash WCB if this roundId is the live flash window
    if (this.flash && !this.flash.resolved && this.flash.roundId === roundId) {
      return this.submitFlashBet(roundId, participantId, participantName, answer);
    }
    // Route to a member-created market if this roundId matches one
    const um = Array.from(this.userMarkets.values()).find((u) => u.state.roundId === roundId);
    if (um && !um.state.resolved) {
      return this.submitUserMarketBet(um.state.targetWord, participantId, participantName, answer);
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
            const { points } = calcScrabbleScore(
              (sub.submission as { words: string[] }).words,
              scrRound.bank,
              scrRound.pool,
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
    if (this.flash?.endTimer) {
      clearTimeout(this.flash.endTimer);
    }
    if (this.flash?.nextTimer) {
      clearTimeout(this.flash.nextTimer);
    }
    if ((this as any)._flashNextTimer) {
      clearTimeout((this as any)._flashNextTimer);
      (this as any)._flashNextTimer = null;
    }
    for (const entry of this.userMarkets.values()) {
      if (entry.endTimer) {
        clearTimeout(entry.endTimer);
        entry.endTimer = null;
      }
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.buffer = [];
    this.currentRound = null;
    this.bingo = null;
    this.flash = null;
    this.userMarkets.clear();
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

