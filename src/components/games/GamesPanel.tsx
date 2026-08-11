import { useState } from 'react';
import { LuGamepad2, LuTrophy, LuTarget, LuDices, LuGrid3X3 } from 'react-icons/lu';
import type { GameRound, LeaderboardEntry, RoomStateSnapshot, StartableGameType } from '../../types/games';
import { getGameTypeLabel, isGameType } from '../../lib/games/engine';
import WhoSaidThat from './WhoSaidThat';
import MeetingScrabble from './MeetingScrabble';
import WordCountMarket from './WordCountMarket';
import FlashBet from './FlashBet';
import UserMarkets from './UserMarkets';
import BingoCard from './BingoCard';
import StatsPanel from './StatsPanel';

interface Props {
  activeRound: GameRound | null;
  leaderboard: LeaderboardEntry[];
  onSubmit: (answer: unknown) => void;
  /** Start a player-chosen game (game:start). */
  onStartGame: (gameType: StartableGameType) => void;
  /** Reason the last game:start was rejected (round running / too little speech). */
  gameStartError: string | null;
  participantId: string | null;
  transcriptionEnabled: boolean;
  /** Quiet mode: host presenting / screen-sharing — notifications suspended. */
  quiet?: boolean;
  /** Always-on games (Layer A) */
  market: RoomStateSnapshot['market'];
  flash: RoomStateSnapshot['flash'];
  userMarkets: RoomStateSnapshot['userMarkets'];
  userMarketError: string | null;
  bingo: RoomStateSnapshot['bingo'];
  stats: RoomStateSnapshot['stats'];
  onMarketBet: (guess: number) => void;
  onFlashBet: (guess: number) => void;
  onCreateUserMarket: (word: string, guess: number, durationSec: number) => void;
  onUserMarketBet: (roundId: string, guess: number) => void;
}

type Tab = 'game' | 'board' | 'stats';

export default function GamesPanel({
  activeRound,
  leaderboard,
  onSubmit,
  onStartGame,
  gameStartError,
  participantId,
  transcriptionEnabled,
  quiet,
  market,
  flash,
  userMarkets,
  userMarketError,
  bingo,
  stats,
  onMarketBet,
  onFlashBet,
  onCreateUserMarket,
  onUserMarketBet,
}: Props) {
  const [tab, setTab] = useState<Tab>('game');

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-3 border-b border-border flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${transcriptionEnabled ? 'bg-success animate-pulse-dot' : 'bg-muted'}`} />
          Games
          {quiet && (
            <span className="text-[10px] font-normal text-muted bg-bg-elevated px-1.5 py-0.5 rounded whitespace-nowrap">
              quiet — presenting
            </span>
          )}
        </h3>
        <div className="flex gap-1">
          <button
            onClick={() => setTab('game')}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors cursor-pointer ${tab === 'game' ? 'bg-primary/20 text-primary' : 'text-muted hover:text-foreground'}`}
          >
            Games
          </button>
          <button
            onClick={() => setTab('board')}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors cursor-pointer ${tab === 'board' ? 'bg-primary/20 text-primary' : 'text-muted hover:text-foreground'}`}
          >
            Leaderboard
          </button>
          <button
            onClick={() => setTab('stats')}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors cursor-pointer ${tab === 'stats' ? 'bg-primary/20 text-primary' : 'text-muted hover:text-foreground'}`}
          >
            Stats
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'game' && (
          <div className="flex flex-col">
            {/* Flash WCB (random window, Layer A) — draw attention, so it sits on top */}
            {flash && (
              <FlashBet flash={flash} onBet={onFlashBet} quiet={quiet} />
            )}
            {/* Always-on market (Layer A) */}
            {market && (
              <WordCountMarket market={market} onBet={onMarketBet} quiet={quiet} />
            )}
            {/* Member-created word bets */}
            <UserMarkets
              markets={userMarkets}
              myParticipantId={participantId}
              error={userMarketError}
              onCreate={onCreateUserMarket}
              onBet={onUserMarketBet}
              quiet={quiet}
            />
            {/* Always-on bingo (Layer A) */}
            {bingo && (
              <BingoCard bingo={bingo} participantId={participantId} quiet={quiet} />
            )}
            {/* Active quick round (Layer B), if any */}
            <ActiveRoundView activeRound={activeRound} onSubmit={onSubmit} onStartGame={onStartGame} />
            {/* Player-chosen game menu — shown whenever no round is running */}
            {!activeRound && <GameMenu onStartGame={onStartGame} transcriptionEnabled={transcriptionEnabled} />}
            {gameStartError && (
              <div className="px-4 py-2 bg-destructive/10 border-b border-destructive/20 text-xs text-destructive">
                {gameStartError}
              </div>
            )}
            {!market && !bingo && !activeRound && !flash && (
              <div className="p-4 text-center space-y-2">
                <div className="w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center mx-auto">
                  <LuGamepad2 className="w-6 h-6 text-primary" />
                </div>
                <p className="text-sm text-foreground">No games yet</p>
                <p className="text-xs text-muted">Pick one above to play — flash word bets still pop up on their own.</p>
              </div>
            )}
          </div>
        )}
        {tab === 'board' && (
          <LeaderboardView leaderboard={leaderboard} participantId={participantId} />
        )}
        {tab === 'stats' && (
          <StatsPanel stats={stats} participantId={participantId} quiet={quiet} />
        )}
      </div>
    </div>
  );
}

const GAME_MENU: Array<{
  type: StartableGameType;
  icon: React.ReactNode;
  title: string;
  desc: string;
  needsSpeech: boolean;
}> = [
  {
    type: 'who_said_that',
    icon: <LuTarget className="w-4 h-4" />,
    title: 'Who Said That?',
    desc: 'A quote from the meeting — guess who said it. Fastest correct answer wins.',
    needsSpeech: true,
  },
  {
    type: 'scrabble',
    icon: <LuGrid3X3 className="w-4 h-4" />,
    title: 'Letter Tiles',
    desc: 'Letters from what was said, scrambled into tiles — spell real meeting words. Long words score more.',
    needsSpeech: true,
  },
  {
    type: 'bingo',
    icon: <LuDices className="w-4 h-4" />,
    title: 'Buzzword Bingo',
    desc: 'Mark your card as the buzzwords get said. First line wins the round.',
    needsSpeech: false,
  },
];

/** Player-chosen game launcher. Shown whenever no quick round is running. */
function GameMenu({
  onStartGame,
  transcriptionEnabled,
}: {
  onStartGame: (gameType: StartableGameType) => void;
  transcriptionEnabled: boolean;
}) {
  return (
    <div className="p-4 border-b border-border space-y-2">
      <p className="text-xs font-medium text-muted uppercase tracking-wider">Start a game</p>
      {GAME_MENU.map((g) => {
        const disabled = g.needsSpeech && !transcriptionEnabled;
        return (
          <button
            key={g.type}
            onClick={() => onStartGame(g.type)}
            disabled={disabled}
            className="w-full text-left flex items-start gap-3 p-3 bg-bg-surface border border-border rounded-xl hover:border-primary/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            title={disabled ? 'Turn on captions to play this one' : undefined}
          >
            <span className="mt-0.5 w-7 h-7 flex items-center justify-center rounded-md bg-primary/15 text-primary flex-shrink-0">
              {g.icon}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">{g.title}</span>
              <span className="block text-xs text-muted mt-0.5">{g.desc}</span>
              {disabled && (
                <span className="block text-[10px] text-warning mt-1">Needs captions on</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ActiveRoundView({
  activeRound,
  onSubmit,
  onStartGame,
}: {
  activeRound: GameRound | null;
  onSubmit: (answer: unknown) => void;
  onStartGame: (gameType: StartableGameType) => void;
}) {
  if (!activeRound) return null;

  const { gameType, state, roundData, id, timeLimit, startedAt } = activeRound;
  const round: GameRound = { id, gameType, state, roundData, timeLimit, startedAt };

  if (state === 'scored') {
    return (
      <div className="p-4 text-center space-y-3 border-b border-border">
        <div className="w-14 h-14 rounded-full bg-success/15 flex items-center justify-center mx-auto">
          <LuTrophy className="w-7 h-7 text-success" />
        </div>
        <h4 className="text-base font-heading font-semibold text-foreground">
          {isGameType(gameType) ? getGameTypeLabel(gameType) : gameType}
        </h4>
        <p className="text-xs text-muted">Round complete — check the leaderboard!</p>
        <button
          onClick={() => onStartGame(gameType as StartableGameType)}
          className="px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-medium hover:bg-primary-hover transition-colors cursor-pointer active:scale-[0.98]"
        >
          Play another round
        </button>
        <button
          onClick={() => onStartGame('bingo')}
          className="px-4 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-foreground hover:border-primary/50 transition-colors cursor-pointer"
        >
          Switch to Buzzword Bingo
        </button>
      </div>
    );
  }

  if (gameType === 'who_said_that') {
    return <div className="border-b border-border"><WhoSaidThat round={round} onSubmit={onSubmit} /></div>;
  }
  if (gameType === 'scrabble') {
    return <div className="border-b border-border"><MeetingScrabble round={round} onSubmit={onSubmit} /></div>;
  }
  return null;
}

function LeaderboardView({ leaderboard, participantId }: { leaderboard: LeaderboardEntry[]; participantId: string | null }) {
  if (leaderboard.length === 0) {
    return (
      <div className="p-4 text-center">
        <p className="text-xs text-muted">No games played yet. The leaderboard fills up after your first round.</p>
      </div>
    );
  }

  return (
    <div className="p-2 w-full min-w-0">
      <div className="w-full min-w-0 overflow-x-auto">
        <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted uppercase tracking-wider">
            <th className="text-left px-2 py-2 font-medium">#</th>
            <th className="text-left px-2 py-2 font-medium">Player</th>
            <th className="text-right px-2 py-2 font-medium">Pts</th>
            <th className="text-right px-2 py-2 font-medium">Pts/round</th>
          </tr>
        </thead>
        <tbody>
          {leaderboard.map((entry, idx) => (
            <tr key={entry.participantId} className={`border-t border-border/50 ${entry.participantId === participantId ? 'bg-primary/10' : ''}`}>
              <td className="px-2 py-2 text-muted font-mono">{idx + 1}</td>
              <td className="px-2 py-2 text-foreground">
                {entry.participantName}
                {entry.participantId === participantId && <span className="text-[10px] text-muted ml-1">(you)</span>}
              </td>
              <td className="px-2 py-2 text-right font-mono text-primary font-medium">{entry.score}</td>
              <td className="px-2 py-2 text-right font-mono text-muted">{entry.pointsPerRound}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
