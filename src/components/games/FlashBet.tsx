import { useEffect, useState } from 'react';
import { FiZap, FiCheck, FiAward, FiClock } from 'react-icons/fi';
import type { RoomStateSnapshot } from '../../types/games';

interface Props {
  flash: NonNullable<RoomStateSnapshot['flash']>;
  onBet: (guess: number) => void;
  quiet?: boolean;
}

function formatTime(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Flash Word Count Bet — a random short-window WCB that pops up mid-call.
 *
 * The server picks a word (from live speech or a curated pool), opens a
 * 60–120s window, and everyone bets how many times the word will be said
 * before time runs out. Odds move in real time as bets land and the count
 * ticks. Payout = accuracy × odds locked at bet time.
 */
export default function FlashBet({ flash, onBet, quiet }: Props) {
  const [guess, setGuess] = useState('');
  const [justBet, setJustBet] = useState(false);
  const [now, setNow] = useState(Date.now());

  // 1s countdown ticker while the window is live
  useEffect(() => {
    if (flash.resolved) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [flash.resolved, flash.roundId]);

  const remainingMs = new Date(flash.endsAt).getTime() - now;
  const live = !flash.resolved && remainingMs > 0;
  const pct = Math.min(100, Math.max(0, (remainingMs / flash.windowMs) * 100));

  const handleBet = () => {
    const g = parseInt(guess, 10);
    if (isNaN(g) || g < 0 || g > 9999) return;
    if (!live || flash.myBet) return;
    onBet(g);
    setJustBet(true);
    setTimeout(() => setJustBet(false), 2500);
  };

  const oddsEntries = Object.entries(flash.odds)
    .map(([guessStr, odds]) => ({ guess: parseInt(guessStr, 10), odds }))
    .sort((a, b) => a.odds - b.odds)
    .slice(0, 3);

  const myLocked = flash.myBet;

  return (
    <div className={`w-full min-w-0 max-w-full p-4 space-y-3 border-b border-border ${quiet ? 'opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <h4 className="text-xs font-medium text-warning uppercase tracking-wider flex items-center gap-1.5 flex-wrap">
          <FiZap className="w-3.5 h-3.5" /> Flash Word Count Bet
          {live && (
            <span className="text-[10px] font-semibold bg-warning/15 text-warning px-1.5 py-0.5 rounded-full animate-pulse-dot">
              LIVE
            </span>
          )}
        </h4>
        {flash.resolved && (
          <span className="text-[10px] font-semibold text-success bg-success/10 px-2 py-0.5 rounded-full">RESOLVED</span>
        )}
      </div>

      {/* Countdown bar */}
      <div>
        <div className="flex items-center justify-between text-[11px] text-muted mb-1">
          <span className="flex items-center gap-1">
            <FiClock className="w-3 h-3" />
            {live ? 'Window open — place your bet!' : flash.resolved ? 'Window closed' : 'Opening…'}
          </span>
          <span className={`font-mono font-semibold ${remainingMs < 15_000 && live ? 'text-warning' : ''}`}>
            {flash.resolved ? formatTime(0) : formatTime(remainingMs)}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-bg-elevated overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-1000 ${remainingMs < 15_000 && live ? 'bg-warning' : 'bg-primary'}`}
            style={{ width: `${live ? pct : 0}%` }}
          />
        </div>
      </div>

      <div className="text-center py-3 bg-bg-elevated rounded-lg border border-border">
        <p className="text-[11px] text-muted mb-1">
          {flash.resolved ? `Final count of…` : 'How many times will they say…'}
        </p>
        <p className="text-2xl font-heading font-bold text-warning">"{flash.targetWord}"</p>
        <p className="text-[11px] text-muted mt-1">
          live count: <strong className="text-foreground font-mono">{flash.liveCount}</strong>
          {flash.resolved && flash.actualCount !== undefined && (
            <span className="ml-2 text-success">✓ {flash.actualCount}</span>
          )}
        </p>
      </div>

      {live && (
        <>
          {oddsEntries.length > 0 && (
            <div>
              <p className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Live odds</p>
              <div className="grid grid-cols-3 gap-1.5">
                {oddsEntries.map(({ guess: g, odds }) => (
                  <div
                    key={g}
                    className={`flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs border ${
                      myLocked?.guess === g
                        ? 'border-warning bg-warning/10 text-foreground'
                        : 'border-border bg-bg-surface text-foreground'
                    }`}
                  >
                    <span className="font-mono">{g}</span>
                    <span className="font-mono font-semibold">×{odds.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

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
                placeholder="Times said?"
                className="flex-1 px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-foreground placeholder:text-muted/50 focus:border-warning outline-none transition-colors"
              />
              <button
                onClick={handleBet}
                className="px-4 py-2 bg-warning hover:bg-warning/90 text-on-primary font-medium rounded-lg transition-colors cursor-pointer text-sm active:scale-[0.98]"
              >
                Bet
              </button>
            </div>
          )}
        </>
      )}

      {flash.resolved && myLocked && flash.actualCount !== undefined && (
        <div className="flex items-center gap-2 bg-bg-elevated border border-border rounded-lg px-3 py-2 text-xs text-foreground">
          <FiAward className="w-4 h-4 text-warning flex-shrink-0" />
          <span>
            Your bet: <strong className="font-mono">{myLocked.guess}</strong> @ ×{myLocked.lockedOdds.toFixed(2)} · final{' '}
            <strong className="font-mono">{flash.actualCount}</strong>
          </span>
        </div>
      )}
    </div>
  );
}
