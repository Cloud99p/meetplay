import { useState } from 'react';
import { FiPlus, FiUsers, FiCheck, FiAward, FiAlertCircle } from 'react-icons/fi';
import type { RoomStateSnapshot } from '../../types/games';

interface Props {
  markets: RoomStateSnapshot['userMarkets'];
  myParticipantId: string | null;
  error: string | null;
  onCreate: (word: string, guess: number) => void;
  onBet: (roundId: string, guess: number) => void;
  quiet?: boolean;
}

/**
 * Member-created word markets — anyone in the call can open a bet on a word
 * ("I think 'synergy' gets said 10 times by end of call"), and everyone else
 * can bet on it too. Resolves at meeting end like the main market.
 */
export default function UserMarkets({ markets, myParticipantId, error, onCreate, onBet, quiet }: Props) {
  const [word, setWord] = useState('');
  const [guess, setGuess] = useState('');
  const [betInputs, setBetInputs] = useState<Record<string, string>>({});

  const canCreate = markets.length < 5;

  const handleCreate = () => {
    const w = word.trim();
    const g = parseInt(guess, 10);
    if (!w || isNaN(g) || g < 0) return;
    onCreate(w, g);
    setWord('');
    setGuess('');
  };

  const handleBet = (roundId: string) => {
    const g = parseInt(betInputs[roundId] ?? '', 10);
    if (isNaN(g) || g < 0 || g > 9999) return;
    onBet(roundId, g);
    setBetInputs((prev) => ({ ...prev, [roundId]: '' }));
  };

  return (
    <div className={`p-4 space-y-3 border-b border-border ${quiet ? 'opacity-70' : ''}`}>
      <h4 className="text-xs font-medium text-muted uppercase tracking-wider flex items-center gap-1.5">
        <FiUsers className="w-3.5 h-3.5 text-secondary" /> Member Word Bets
        <span className="text-[10px] font-normal text-muted bg-bg-elevated px-1.5 py-0.5 rounded-full">
          {markets.length}/5
        </span>
      </h4>

      {/* Create form */}
      {canCreate && (
        <div className="bg-bg-elevated border border-border rounded-lg p-2.5 space-y-2">
          <p className="text-[11px] text-muted">Open a bet — pick a word + your guess. Others can bet on it too.</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={word}
              onChange={(e) => setWord(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="Word (e.g. synergy)"
              maxLength={20}
              className="flex-1 px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-foreground placeholder:text-muted/50 focus:border-secondary outline-none transition-colors"
            />
            <input
              type="number"
              min={0}
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="Your guess"
              className="w-24 px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-foreground placeholder:text-muted/50 focus:border-secondary outline-none transition-colors"
            />
            <button
              onClick={handleCreate}
              className="px-3 py-2 bg-secondary hover:bg-secondary/90 text-on-primary font-medium rounded-lg transition-colors cursor-pointer text-sm active:scale-[0.98] flex items-center gap-1"
            >
              <FiPlus className="w-4 h-4" /> Open
            </button>
          </div>
          {error && (
            <p className="text-[11px] text-danger flex items-center gap-1">
              <FiAlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {error}
            </p>
          )}
        </div>
      )}

      {/* Market list */}
      {markets.length === 0 ? (
        <p className="text-[11px] text-muted/70">No member markets yet — open the first one!</p>
      ) : (
        <div className="space-y-2">
          {markets.map((m) => {
            const myBet = m.myBet;
            const oddsEntries = Object.entries(m.odds)
              .map(([guessStr, odds]) => ({ guess: parseInt(guessStr, 10), odds }))
              .sort((a, b) => a.odds - b.odds)
              .slice(0, 3);
            const mine = m.createdBy === myParticipantId;
            return (
              <div key={m.roundId} className="bg-bg-surface border border-border rounded-lg p-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-foreground">
                    "{m.targetWord}"
                    {mine && <span className="text-[10px] text-primary ml-1.5 bg-primary/10 px-1.5 py-0.5 rounded-full">yours</span>}
                  </p>
                  <div className="flex items-center gap-2">
                    {m.resolved && (
                      <span className="text-[10px] font-semibold text-success bg-success/10 px-2 py-0.5 rounded-full">RESOLVED</span>
                    )}
                    <span className="text-[10px] text-muted">by {m.createdByName}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between text-[11px] text-muted">
                  <span>
                    live count: <strong className="text-foreground font-mono">{m.liveCount}</strong>
                    {m.resolved && m.actualCount !== undefined && (
                      <span className="ml-1.5 text-success">✓ {m.actualCount}</span>
                    )}
                  </span>
                  <div className="flex gap-1">
                    {oddsEntries.map(({ guess: g, odds }) => (
                      <span
                        key={g}
                        className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                          myBet?.guess === g ? 'bg-secondary/15 text-foreground border border-secondary/40' : 'bg-bg-elevated text-muted'
                        }`}
                      >
                        {g} ×{odds.toFixed(2)}
                      </span>
                    ))}
                  </div>
                </div>
                {!m.resolved &&
                  (myBet ? (
                    <div className="flex items-center gap-2 bg-success/10 border border-success/30 rounded-lg px-2.5 py-1.5 text-xs text-foreground">
                      <FiCheck className="w-3.5 h-3.5 text-success flex-shrink-0" />
                      <span>
                        You bet <strong className="font-mono">{myBet.guess}</strong> @ <strong className="font-mono">×{myBet.lockedOdds.toFixed(2)}</strong>
                      </span>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min={0}
                        value={betInputs[m.roundId] ?? ''}
                        onChange={(e) => setBetInputs((prev) => ({ ...prev, [m.roundId]: e.target.value }))}
                        onKeyDown={(e) => e.key === 'Enter' && handleBet(m.roundId)}
                        placeholder="Times said?"
                        className="flex-1 px-2.5 py-1.5 bg-bg-elevated border border-border rounded-lg text-xs text-foreground placeholder:text-muted/50 focus:border-secondary outline-none transition-colors"
                      />
                      <button
                        onClick={() => handleBet(m.roundId)}
                        className="px-3 py-1.5 bg-secondary hover:bg-secondary/90 text-on-primary font-medium rounded-lg transition-colors cursor-pointer text-xs active:scale-[0.98]"
                      >
                        Bet
                      </button>
                    </div>
                  ))}
                {m.resolved && myBet && m.actualCount !== undefined && (
                  <div className="flex items-center gap-2 bg-bg-elevated border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground">
                    <FiAward className="w-3.5 h-3.5 text-warning flex-shrink-0" />
                    <span>
                      Your bet: <strong className="font-mono">{myBet.guess}</strong> @ ×{myBet.lockedOdds.toFixed(2)} · final{' '}
                      <strong className="font-mono">{m.actualCount}</strong>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
