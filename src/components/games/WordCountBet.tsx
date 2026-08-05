import { useState, useEffect, useRef } from 'react';
import type { GameRound } from '../../types/games';
import { getRoundTimeRemaining, formatTime } from '../../lib/games/engine';
import { isWordCountBetQuestion } from '../../lib/games/wordCountBet';

interface Props {
  round: GameRound;
  onSubmit: (answer: unknown) => void;
  disabled?: boolean;
}

export default function WordCountBet({ round, onSubmit, disabled }: Props) {
  const [guess, setGuess] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [timeLeft, setTimeLeft] = useState(getRoundTimeRemaining(round.startedAt, round.timeLimit));
  const submittedRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft(getRoundTimeRemaining(round.startedAt, round.timeLimit));
    }, 1000);
    return () => clearInterval(timer);
  }, [round.startedAt, round.timeLimit]);

  if (!isWordCountBetQuestion(round.roundData)) return null;
  const question = round.roundData;
  const targetWord = question.targetWord;

  const handleSubmit = () => {
    const g = parseInt(guess, 10);
    if (isNaN(g) || g < 0 || g > 9999) return;
    if (submittedRef.current || disabled || round.state !== 'open') return;
    submittedRef.current = true;
    setSubmitted(true);
    onSubmit({ guess: g });
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted uppercase tracking-wider">Word Count Bet</h4>
        <span className="text-sm font-mono text-warning">⏱ {formatTime(timeLeft)}</span>
      </div>

      <div className="text-center py-4 bg-bg-elevated rounded-lg border border-border">
        <p className="text-xs text-muted mb-2">How many times will someone say…</p>
        <p className="text-3xl font-heading font-bold text-primary">{targetWord}</p>
        <p className="text-xs text-muted mt-2">(plural forms and partial matches count)</p>
      </div>

      <div>
        <label className="block text-sm text-foreground mb-1.5">Your bet</label>
        <div className="flex gap-2">
          <input
            type="number"
            min={0}
            value={guess}
            onChange={(e) => setGuess(e.target.value)}
            placeholder="e.g. 12"
            className="flex-1 px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-foreground placeholder:text-muted/50 focus:border-primary outline-none transition-colors"
          />
          <button
            onClick={handleSubmit}
            disabled={disabled || round.state !== 'open' || submitted}
            className="px-5 py-2 bg-primary hover:bg-primary-hover text-on-primary font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer text-sm active:scale-[0.98]"
          >
            {submitted ? 'Locked ✓' : 'Bet'}
          </button>
        </div>
        {round.state === 'scored' && (
          <p className="text-xs text-muted mt-2">
            Actual count: <strong className="text-foreground">{question.actualCount ?? '—'}</strong>
          </p>
        )}
      </div>
    </div>
  );
}