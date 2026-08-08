import { useState } from 'react';
import { FiTrendingUp, FiCheck, FiAward } from 'react-icons/fi';
import type { RoomStateSnapshot } from '../../types/games';

interface Props {
  market: NonNullable<RoomStateSnapshot['market']>;
  onBet: (guess: number) => void;
  quiet?: boolean;
}

/**
 * Word Count Bet v2 — call-long prediction market.
 *
 * Opens at the start of the call and stays open until the room ends. The
 * live count ticks up as the word is spoken; odds for every bet shift in
 * real time as more people vote and as the count moves. Payout is
 * closeness × odds locked at bet time.
 */
export default function WordCountMarket({ market, onBet, quiet }: Props) {
  const [guess, setGuess] = useState('');
  const [justBet, setJustBet] = useState(false);

  const handleBet = () => {
    const g = parseInt(guess, 10);
    if (isNaN(g) || g < 0 || g > 9999) return;
    if (market.resolved || market.myBet) return;
    onBet(g);
    setJustBet(true);
    setTimeout(() => setJustBet(false), 2500);
  };

  // Top odds to show: the most likely (lowest odds) up to 4
  const oddsEntries = Object.entries(market.odds)
    .map(([guessStr, odds]) => ({ guess: parseInt(guessStr, 10), odds }))
    .sort((a, b) => a.odds - b.odds)
    .slice(0, 4);

  const myLocked = market.myBet;

  return (
    <div className={`w-full min-w-0 max-w-full p-4 space-y-3 border-b border-border ${quiet ? 'opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <h4 className="text-xs font-medium text-muted uppercase tracking-wider flex items-center gap-1.5">
          <FiTrendingUp className="w-3.5 h-3.5 text-primary" /> Word Count Bet
          <span className="text-[10px] font-normal text-muted bg-bg-elevated px-1.5 py-0.5 rounded-full">live all call</span>
        </h4>
        {market.resolved && (
          <span className="text-[10px] font-semibold text-success bg-success/10 px-2 py-0.5 rounded-full">RESOLVED</span>
        )}
      </div>

      <div className="text-center py-3 bg-bg-elevated rounded-lg border border-border">
        <p className="text-[11px] text-muted mb-1">Final count of…</p>
        <p className="text-2xl font-heading font-bold text-primary break-words min-w-0">"{market.targetWord}"</p>
        <p className="text-[11px] text-muted mt-1">
          live count: <strong className="text-foreground font-mono">{market.liveCount}</strong>
          {market.resolved && market.actualCount !== undefined && (
            <span className="ml-2 text-success">✓ {market.actualCount}</span>
          )}
        </p>
      </div>

      {!market.resolved && (
        <>
          {/* Live odds */}
          {oddsEntries.length > 0 && (
            <div>
              <p className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Live odds</p>
              <div className="grid grid-cols-2 gap-1.5">
                {oddsEntries.map(({ guess: g, odds }) => (
                  <div
                    key={g}
                    className={`flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs border ${
                      myLocked?.guess === g
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-bg-surface text-foreground'
                    }`}
                  >
                    <span className="font-mono">{g}</span>
                    <span className="font-mono font-semibold">×{odds.toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted/70 mt-1">
                Odds update as people bet and the count moves. Payout = accuracy × odds at bet time (max ×5).
              </p>
            </div>
          )}

          {/* Bet input */}
          {myLocked ? (
            <div className="flex items-center gap-2 bg-success/10 border border-success/30 rounded-lg px-3 py-2 text-xs text-foreground">
              <FiCheck className="w-4 h-4 text-success flex-shrink-0" />
              <span>
                You bet <strong className="font-mono">{myLocked.guess}</strong> at{' '}
                <strong className="font-mono">×{myLocked.lockedOdds.toFixed(2)}</strong>
                {justBet && <span className="text-success ml-1">locked!</span>}
              </span>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="number"
                min={0}
                value={guess}
                onChange={(e) => setGuess(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleBet()}
                placeholder="Guess final count"
                className="flex-1 px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-foreground placeholder:text-muted/50 focus:border-primary outline-none transition-colors"
              />
              <button
                onClick={handleBet}
                className="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary font-medium rounded-lg transition-colors cursor-pointer text-sm active:scale-[0.98]"
              >
                Bet
              </button>
            </div>
          )}
        </>
      )}

      {market.resolved && myLocked && market.actualCount !== undefined && (
        <div className="flex items-center gap-2 bg-bg-elevated border border-border rounded-lg px-3 py-2 text-xs text-foreground">
          <FiAward className="w-4 h-4 text-warning flex-shrink-0" />
          <span>
            Your bet: <strong className="font-mono">{myLocked.guess}</strong> @ ×{myLocked.lockedOdds.toFixed(2)} · final{' '}
            <strong className="font-mono">{market.actualCount}</strong>
          </span>
        </div>
      )}
    </div>
  );
}
