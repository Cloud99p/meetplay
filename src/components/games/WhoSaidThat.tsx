import { useEffect, useRef, useState } from 'react';
import { FiClock } from 'react-icons/fi';
import type { GameRound } from '../../types/games';
import { getRoundTimeRemaining, formatTime } from '../../lib/games/engine';

interface Props {
  round: GameRound;
  onSubmit: (answer: unknown) => void;
  disabled?: boolean;
}

export default function WhoSaidThat({ round, onSubmit, disabled }: Props) {
  const question = round.roundData as { quote: string; speakerId: string; options: Array<{ id: string; name: string }> } | null;
  const [selected, setSelected] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState(getRoundTimeRemaining(round.startedAt, round.timeLimit));
  const submittedRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft(getRoundTimeRemaining(round.startedAt, round.timeLimit));
    }, 1000);
    return () => clearInterval(timer);
  }, [round.startedAt, round.timeLimit]);

  if (!question) return null;

  const handleSelect = (optionId: string) => {
    if (submittedRef.current || disabled || round.state !== 'open') return;
    submittedRef.current = true;
    setSelected(optionId);
    onSubmit({ answer: optionId });
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted uppercase tracking-wider">Who Said That?</h4>
        <span className="text-sm font-mono text-warning flex items-center gap-1"><FiClock className="w-3.5 h-3.5" />{formatTime(timeLeft)}</span>
      </div>

      <blockquote className="border-l-4 border-primary bg-bg-elevated rounded-r-lg px-4 py-3 text-foreground text-sm italic leading-relaxed">
        “{question.quote}”
      </blockquote>

      <div className="space-y-2">
        {question.options.map((opt) => {
          const isSelected = selected === opt.id;
          const isCorrect = round.state === 'scored' && opt.id === question.speakerId;
          return (
            <button
              key={opt.id}
              onClick={() => handleSelect(opt.id)}
              disabled={disabled || round.state !== 'open' || submittedRef.current}
              className={[
                'w-full text-left px-4 py-2.5 rounded-lg border text-sm transition-colors duration-150 cursor-pointer active:scale-[0.99]',
                isCorrect ? 'border-success bg-success/15 text-success font-medium'
                : isSelected ? 'border-primary bg-primary/15 text-foreground'
                : 'border-border bg-bg-surface hover:border-primary/40 text-foreground',
                (disabled || round.state !== 'open') && !isCorrect && !isSelected ? 'opacity-60 cursor-not-allowed' : '',
              ].join(' ')}
            >
              <span className="flex items-center gap-2">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-heading font-semibold ${isSelected || isCorrect ? 'bg-primary/20 text-primary' : 'bg-bg-elevated text-muted'}`}>
                  {opt.name.charAt(0).toUpperCase()}
                </span>
                {opt.name}
              </span>
            </button>
          );
        })}
      </div>

      {round.state === 'scored' && (
        <p className="text-xs text-muted text-center pt-1">
          {selected === question.speakerId ? 'Correct!' : `Answer: ${question.options.find((o) => o.id === question.speakerId)?.name}`}
        </p>
      )}
    </div>
  );
}