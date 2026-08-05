import { useState, useEffect, useRef } from 'react';
import { FiPlus, FiX } from 'react-icons/fi';
import type { GameRound } from '../../types/games';
import { getRoundTimeRemaining, formatTime } from '../../lib/games/engine';
import { isScrabbleQuestion } from '../../lib/games/scrabble';

interface Props {
  round: GameRound;
  onSubmit: (answer: unknown) => void;
  disabled?: boolean;
}

export default function MeetingScrabble({ round, onSubmit, disabled }: Props) {
  const [typedWord, setTypedWord] = useState('');
  const [myWords, setMyWords] = useState<string[]>([]);
  const [timeLeft, setTimeLeft] = useState(getRoundTimeRemaining(round.startedAt, round.timeLimit));
  const submittedRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft(getRoundTimeRemaining(round.startedAt, round.timeLimit));
    }, 1000);
    return () => clearInterval(timer);
  }, [round.startedAt, round.timeLimit]);

  if (!isScrabbleQuestion(round.roundData)) return null;
  const bank = round.roundData.bank;

  const addWord = () => {
    const w = typedWord.toLowerCase().trim();
    if (!w || myWords.includes(w) || !bank.includes(w)) return;
    setMyWords((prev) => [...prev, w]);
    setTypedWord('');
  };

  const handleSubmit = () => {
    if (submittedRef.current || disabled || round.state !== 'open') return;
    submittedRef.current = true;
    onSubmit({ words: myWords });
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted uppercase tracking-wider">Meeting Scrabble</h4>
        <span className="text-sm font-mono text-warning">⏱ {formatTime(timeLeft)}</span>
      </div>

      <div>
        <p className="text-xs text-muted mb-1.5">Word bank (from what's been said):</p>
        <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
          {bank.map((w) => (
            <button
              key={w}
              onClick={() => {
                setTypedWord(w);
              }}
              className="px-2 py-0.5 bg-bg-elevated hover:bg-primary/20 text-xs rounded-md text-foreground transition-colors cursor-pointer"
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <input
          value={typedWord}
          onChange={(e) => setTypedWord(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addWord()}
          placeholder="Type a word from the bank…"
          className="flex-1 px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-foreground placeholder:text-muted/50 focus:border-primary outline-none transition-colors"
        />
        <button
          onClick={addWord}
          disabled={!typedWord.trim() || !bank.includes(typedWord.toLowerCase().trim())}
          className="px-3 py-2 bg-primary text-on-primary rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          <FiPlus className="w-4 h-4" />
        </button>
      </div>

      <div>
        <p className="text-xs text-muted mb-1.5">Your words ({myWords.length}):</p>
        {myWords.length === 0 ? (
          <p className="text-xs text-muted/60">Pick words from the bank above. Unique words score bonus points!</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {myWords.map((w) => (
              <span key={w} className="px-2 py-0.5 bg-secondary/15 text-secondary rounded-md text-xs flex items-center gap-1">
                {w}
                <button
                  onClick={() => setMyWords((prev) => prev.filter((x) => x !== w))}
                  className="hover:text-destructive transition-colors cursor-pointer"
                >
                  <FiX className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={handleSubmit}
        disabled={disabled || round.state !== 'open' || submittedRef.current}
        className="w-full py-2.5 bg-secondary hover:opacity-90 text-on-primary font-medium rounded-lg transition-opacity disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer text-sm active:scale-[0.98]"
      >
        {submittedRef.current ? 'Submitted ✓' : `Submit ${myWords.length} word${myWords.length === 1 ? '' : 's'}`}
      </button>
    </div>
  );
}