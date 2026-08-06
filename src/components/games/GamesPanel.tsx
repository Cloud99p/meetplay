import { useState } from 'react';
import { LuGamepad2, LuTrophy } from 'react-icons/lu';
import type { GameRound, LeaderboardEntry } from '../../types/games';
import { getGameTypeLabel, isGameType } from '../../lib/games/engine';
import WhoSaidThat from './WhoSaidThat';
import MeetingScrabble from './MeetingScrabble';
import WordCountBet from './WordCountBet';

interface Props {
  activeRound: GameRound | null;
  leaderboard: LeaderboardEntry[];
  onSubmit: (answer: unknown) => void;
  participantId: string | null;
  transcriptionEnabled: boolean;
  /** Quiet mode: host presenting / screen-sharing — notifications suspended. */
  quiet?: boolean;
}

export default function GamesPanel({ activeRound, leaderboard, onSubmit, participantId, transcriptionEnabled, quiet }: Props) {
  const [tab, setTab] = useState<'game' | 'board'>('game');

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${transcriptionEnabled ? 'bg-success animate-pulse-dot' : 'bg-muted'}`} />
          Games
          {quiet && (
            <span className="text-[10px] font-normal text-muted bg-bg-elevated px-1.5 py-0.5 rounded">
              quiet — presenting
            </span>
          )}
        </h3>
        <div className="flex gap-1">
          <button
            onClick={() => setTab('game')}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors cursor-pointer ${tab === 'game' ? 'bg-primary/20 text-primary' : 'text-muted hover:text-foreground'}`}
          >
            Round
          </button>
          <button
            onClick={() => setTab('board')}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors cursor-pointer ${tab === 'board' ? 'bg-primary/20 text-primary' : 'text-muted hover:text-foreground'}`}
          >
            Leaderboard
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'game' ? (
          <ActiveRoundView activeRound={activeRound} onSubmit={onSubmit} />
        ) : (
          <LeaderboardView leaderboard={leaderboard} participantId={participantId} />
        )}
      </div>
    </div>
  );
}

function ActiveRoundView({
  activeRound,
  onSubmit,
}: {
  activeRound: GameRound | null;
  onSubmit: (answer: unknown) => void;
}) {
  if (!activeRound) {
    return (
      <div className="p-4 text-center space-y-2">
        <div className="w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center mx-auto">
          <LuGamepad2 className="w-6 h-6 text-primary" />
        </div>
        <p className="text-sm text-foreground">No active round</p>
        <p className="text-xs text-muted">Rounds start automatically as the conversation flows. Keep talking!</p>
      </div>
    );
  }

  const { gameType, state, roundData, id, timeLimit, startedAt } = activeRound;
  const round: GameRound = { id, gameType, state, roundData, timeLimit, startedAt };

  if (state === 'scored') {
    return (
      <div className="p-4 text-center space-y-3">
        <div className="w-14 h-14 rounded-full bg-success/15 flex items-center justify-center mx-auto">
          <LuTrophy className="w-7 h-7 text-success" />
        </div>
        <h4 className="text-base font-heading font-semibold text-foreground">
          {isGameType(gameType) ? getGameTypeLabel(gameType) : gameType}
        </h4>
        <p className="text-xs text-muted">Round complete — check the leaderboard!</p>
      </div>
    );
  }

  if (gameType === 'who_said_that') {
    return <WhoSaidThat round={round} onSubmit={onSubmit} />;
  }
  if (gameType === 'scrabble') {
    return <MeetingScrabble round={round} onSubmit={onSubmit} />;
  }
  if (gameType === 'word_count_bet') {
    return <WordCountBet round={round} onSubmit={onSubmit} />;
  }
  return <p className="p-4 text-xs text-muted">Unknown game: {gameType}</p>;
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
    <div className="p-2">
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
  );
}