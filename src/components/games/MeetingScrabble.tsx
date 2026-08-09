import { useState, useEffect, useRef } from 'react';
import { FiPlus, FiX, FiClock, FiCheck, FiDelete, FiRotateCcw } from 'react-icons/fi';
import type { GameRound } from '../../types/games';
import { getRoundTimeRemaining, formatTime } from '../../lib/games/engine';
import { isScrabbleQuestion, validateWord, canFormWord, wordPoints } from '../../lib/games/scrabble';

interface Props {
  round: GameRound;
  onSubmit: (answer: unknown) => void;
  disabled?: boolean;
}

/**
 * Letter Tiles — Boggle-style Meeting Scrabble.
 * The word bank is HIDDEN. The server harvests letters from real meeting
 * words into a shuffled tile pool; players spell words they remember hearing.
 * A word scores only if it was actually said in the meeting (in the bank)
 * and can be spelled from the tiles.
 */
export default function MeetingScrabble({ round, onSubmit, disabled }: Props) {
  const [used, setUsed] = useState<number[]>([]);
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
  const pool = round.roundData.pool;

  const currentWord = used.map((i) => pool[i]).join('').toLowerCase();
  const isValid =
    currentWord.length >= 2 && validateWord(currentWord, bank) && canFormWord(currentWord, pool);
  const poolPoints = myWords.reduce((sum, w) => sum + wordPoints(w), 0);

  const clickTile = (idx: number) => {
    if (used.includes(idx)) return;
    setUsed((prev) => [...prev, idx]);
  };

  const addWord = () => {
    if (!isValid || myWords.includes(currentWord)) return;
    setMyWords((prev) => [...prev, currentWord]);
    setUsed([]);
  };

  const handleSubmit = () => {
    if (submittedRef.current || disabled || round.state !== 'open') return;
    submittedRef.current = true;
    onSubmit({ words: myWords });
  };

  return (
    <div className="w-full min-w-0 max-w-full p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted uppercase tracking-wider">Letter Tiles</h4>
        <span className="text-sm font-mono text-warning flex items-center gap-1"><FiClock className="w-3.5 h-3.5" />{formatTime(timeLeft)}</span>
      </div>

      {pool.length === 0 ? (
        <p className="text-sm text-muted text-center py-4">
          Not enough words yet — keep talking and start the game again.
        </p>
      ) : (
        <>
          <div>
            <p className="text-xs text-muted mb-1.5">
              Spell words from the meeting — letters come from what's been said ({bank.length} hidden words).
            </p>
            <div className="flex flex-wrap gap-1.5">
              {pool.map((letter, idx) => (
                <button
                  key={idx}
                  onClick={() => clickTile(idx)}
                  disabled={used.includes(idx)}
                  className={`w-8 h-8 flex items-center justify-center rounded-md text-sm font-bold transition-colors cursor-pointer ${
                    used.includes(idx)
                      ? 'bg-bg-surface text-muted/30 border border-border'
                      : 'bg-bg-elevated hover:bg-primary/25 text-foreground border border-border hover:border-primary'
                  }`}
                >
                  {letter.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2 items-center">
            <div className="flex-1 px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-foreground min-h-[38px] flex items-center gap-1 flex-wrap">
              {used.length === 0 ? (
                <span className="text-muted/50">Click tiles to build a word…</span>
              ) : (
                used.map((idx, pos) => (
                  <span key={pos} className="font-bold">{pool[idx].toUpperCase()}</span>
                ))
              )}
            </div>
            <button
              onClick={() => setUsed((prev) => prev.slice(0, -1))}
              disabled={used.length === 0}
              className="px-2 py-2 bg-bg-elevated border border-border rounded-lg text-muted hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              title="Backspace"
            >
              <FiDelete className="w-4 h-4" />
            </button>
            <button
              onClick={() => setUsed([])}
              disabled={used.length === 0}
              className="px-2 py-2 bg-bg-elevated border border-border rounded-lg text-muted hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              title="Clear"
            >
              <FiRotateCcw className="w-4 h-4" />
            </button>
            <button
              onClick={addWord}
              disabled={!isValid || myWords.includes(currentWord)}
              className="px-3 py-2 bg-primary text-on-primary rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              title="Add word"
            >
              <FiPlus className="w-4 h-4" />
            </button>
          </div>

          <div className="text-xs">
            {currentWord && (
              <span className={isValid ? 'text-success' : 'text-muted'}>
                {isValid
                  ? `✓ "${currentWord}" — ${wordPoints(currentWord)} pts`
                  : `"${currentWord}" — not a word from this meeting (or can't be spelled from tiles)`}
              </span>
            )}
          </div>

          <div>
            <p className="text-xs text-muted mb-1.5">Your words ({myWords.length}) — {poolPoints} pts before uniqueness bonus:</p>
            {myWords.length === 0 ? (
              <p className="text-xs text-muted/60">Longer words score more. Unique words earn +500!</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {myWords.map((w) => (
                  <span key={w} className="px-2 py-0.5 bg-secondary/15 text-secondary rounded-md text-xs flex items-center gap-1">
                    {w} <span className="text-secondary/70">+{wordPoints(w)}</span>
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
            {submittedRef.current ? <span className="flex items-center gap-1 justify-center"><FiCheck className="w-4 h-4" /> Submitted ({myWords.length})</span> : `Submit ${myWords.length} word${myWords.length === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    </div>
  );
}
