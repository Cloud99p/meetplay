import { useState, useEffect, useMemo } from 'react';
import * as api from '../../lib/api';
import type { RecapData } from '../../lib/api';
import {
  FiClock, FiMessageSquare, FiAward, FiUsers, FiChevronLeft,
  FiLink, FiCheck, FiSearch, FiStar, FiMessageCircle,
} from 'react-icons/fi';

interface Props {
  roomId: string;
  onBack: () => void;
}

const GAME_LABELS: Record<string, string> = {
  who_said_that: 'Who Said That?',
  scrabble: 'Meeting Scrabble',
  word_count_bet: 'Word Count Bet',
  flash_wcb: '⚡ Flash Word Count Bet',
  user_word_bet: '👥 Member Word Bet',
  bingo: 'Buzzword Bingo',
  recap_quiz: 'Recap Quiz',
};

export default function RecapPage({ roomId, onBack }: Props) {
  const [recap, setRecap] = useState<RecapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        // The recap contains the full transcript — the server requires a valid
        // room token (sessionStorage) so a bare /recap/:roomId link can't be
        // scraped by anyone who guesses the UUID.
        const token = api.getRoomToken();
        if (!token) {
          setError('This recap requires an active meeting session. Join the meeting to view it.');
          setLoading(false);
          return;
        }
        const data = await api.getRecap(roomId, token);
        setRecap(data);
      } catch (e: any) {
        setError(e?.message ?? 'Failed to load recap');
      } finally {
        setLoading(false);
      }
    })();
  }, [roomId]);

  const filteredTranscript = useMemo(() => {
    if (!recap?.transcript) return [];
    const q = search.trim().toLowerCase();
    if (!q) return recap.transcript;
    return recap.transcript.filter(
      (t) => t.text.toLowerCase().includes(q) || t.participantName.toLowerCase().includes(q)
    );
  }, [recap, search]);

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const roundWinner = (submissions: RecapData['gameRounds'][0]['submissions']) => {
    if (!submissions || submissions.length === 0) return null;
    return submissions.reduce((best, s) => (s.score > best.score ? s : best));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-bg-base flex items-center justify-center">
        <p className="text-muted text-sm">Loading recap…</p>
      </div>
    );
  }

  if (error || !recap) {
    return (
      <div className="min-h-screen bg-bg-base flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-destructive text-sm">{error || 'Recap not available'}</p>
          <button onClick={onBack} className="text-primary text-sm underline cursor-pointer">Back to lobby</button>
        </div>
      </div>
    );
  }

  const leaderboard = recap.leaderboard ?? [];
  const keyQuotes = recap.keyQuotes ?? [];
  const quizRound = recap.gameRounds.find((r) => r.gameType === 'recap_quiz');
  const gameRounds = recap.gameRounds.filter((r) => r.gameType !== 'recap_quiz');
  const quizQuestions = (quizRound?.roundData as any)?.questions;

  return (
    <div className="min-h-screen bg-bg-base print:bg-white">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-8 print:max-w-none print:px-0 print:py-0">
        {/* Header */}
        <div className="flex items-center gap-3 print:hidden">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 p-2 rounded-lg hover:bg-bg-elevated text-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <FiChevronLeft className="w-5 h-5" />
            <span className="text-xs font-medium">Lobby</span>
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-heading font-bold text-foreground">Meeting Recap</h1>
            <p className="text-xs text-muted">
              {recap.room.name || 'Untitled Room'} · {new Date(recap.room.createdAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => window.print()}
              className="px-3 py-1.5 text-xs font-medium bg-bg-elevated hover:bg-border rounded-md transition-colors cursor-pointer text-foreground"
            >
              Print
            </button>
            <button
              onClick={copyLink}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary/15 hover:bg-primary/25 text-primary rounded-md transition-colors cursor-pointer"
            >
              {copied ? <FiCheck className="w-3.5 h-3.5" /> : <FiLink className="w-3.5 h-3.5" />}
              {copied ? 'Copied!' : 'Share recap'}
            </button>
          </div>
        </div>

        {/* Print-only header */}
        <div className="hidden print:block">
          <h1 className="text-2xl font-bold">Meeting Recap</h1>
          <p className="text-sm">{recap.room.name || 'Untitled Room'} · {new Date(recap.room.createdAt).toLocaleString()}</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-bg-surface border border-border rounded-xl p-4 text-center">
            <FiUsers className="w-5 h-5 text-primary mx-auto mb-1" />
            <p className="text-2xl font-heading font-bold text-foreground">{recap.participants.length}</p>
            <p className="text-xs text-muted">Participants</p>
          </div>
          <div className="bg-bg-surface border border-border rounded-xl p-4 text-center">
            <FiClock className="w-5 h-5 text-secondary mx-auto mb-1" />
            <p className="text-2xl font-heading font-bold text-foreground">{formatDuration(recap.room.duration)}</p>
            <p className="text-xs text-muted">Duration</p>
          </div>
          <div className="bg-bg-surface border border-border rounded-xl p-4 text-center">
            <FiAward className="w-5 h-5 text-accent mx-auto mb-1" />
            <p className="text-2xl font-heading font-bold text-foreground">{recap.gameRounds.length}</p>
            <p className="text-xs text-muted">Game Rounds</p>
          </div>
        </div>

        {/* 1.5. Recap quiz — did you actually listen? */}
        {quizQuestions && quizQuestions.length > 0 && (
          <QuizSection questions={quizQuestions} />
        )}

        {/* 2. Meeting info: participants with join times */}
        <section>
          <h2 className="text-sm font-heading font-semibold text-foreground mb-3 flex items-center gap-2">
            <FiUsers className="w-4 h-4 text-primary" /> Participants
          </h2>
          <div className="bg-bg-surface border border-border rounded-xl divide-y divide-border">
            {recap.participants.map((p) => (
              <div key={p.id} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-sm text-foreground">
                  {p.name}
                  {p.isHost && <span className="ml-2 text-[10px] font-semibold bg-primary/15 text-primary px-1.5 py-0.5 rounded">HOST</span>}
                </span>
                <span className="text-xs text-muted">joined {formatTime(p.joinedAt)}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 2. Transcript (searchable) */}
        <section>
          <h2 className="text-sm font-heading font-semibold text-foreground mb-3 flex items-center gap-2">
            <FiMessageSquare className="w-4 h-4 text-secondary" /> Transcript
          </h2>
          {recap.transcript && recap.transcript.length > 0 ? (
            <div className="bg-bg-surface border border-border rounded-xl">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
                <FiSearch className="w-4 h-4 text-muted flex-shrink-0" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search transcript…"
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted/50 outline-none"
                />
                {search && (
                  <span className="text-[10px] text-muted">{filteredTranscript.length} matches</span>
                )}
              </div>
              <div className="max-h-80 overflow-y-auto divide-y divide-border">
                {filteredTranscript.length > 0 ? (
                  filteredTranscript.map((t) => (
                    <div key={t.id} className="flex gap-2 px-4 py-2 text-sm">
                      <span className="font-medium text-primary flex-shrink-0 min-w-16">{t.participantName}:</span>
                      <span className="text-foreground">{t.text}</span>
                      <span className="ml-auto text-[10px] text-muted flex-shrink-0 self-center">{formatTime(t.createdAt)}</span>
                    </div>
                  ))
                ) : (
                  <p className="px-4 py-6 text-sm text-muted text-center">No matches for "{search}"</p>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-bg-surface border border-border rounded-xl p-6 text-center">
              <FiMessageSquare className="w-8 h-8 text-muted/40 mx-auto mb-2" />
              <p className="text-sm text-muted">No transcript available for this meeting.</p>
              <p className="text-xs text-muted/60 mt-1">Transcripts are only recorded when captions are enabled.</p>
            </div>
          )}
        </section>

        {/* 3. Game winners */}
        {gameRounds.length > 0 && (
        <section>
          <h2 className="text-sm font-heading font-semibold text-foreground mb-3 flex items-center gap-2">
            <FiAward className="w-4 h-4 text-accent" /> Game Rounds
          </h2>
          <div className="space-y-3">
              {gameRounds.map((round) => {
                const winner = roundWinner(round.submissions);
                return (
                  <div key={round.id} className="bg-bg-surface border border-border rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-primary uppercase tracking-wider">
                        {GAME_LABELS[round.gameType] ?? round.gameType}
                      </span>
                      <span className="text-[10px] text-muted">
                        {formatTime(round.startedAt)} · {formatDuration(
                          round.endedAt
                            ? Math.max(0, (new Date(round.endedAt).getTime() - new Date(round.startedAt).getTime()) / 1000)
                            : 0
                        )}
                      </span>
                    </div>
                    {/* Question (Who Said That / Word Count) */}
                    {round.gameType === 'who_said_that' && (
                      <p className="text-sm text-foreground italic mb-2">"{String((round.roundData as any)?.quote ?? '')}"</p>
                    )}
                    {round.gameType === 'word_count_bet' && (
                      <p className="text-sm text-foreground mb-2">
                        Target word: <strong className="text-primary">"{String((round.roundData as any)?.targetWord ?? '')}"</strong>
                        {Boolean(round.roundData && (round.roundData as any).actualCount !== undefined) && (
                          <span className="text-muted ml-2">actual count: {String((round.roundData as any).actualCount)}</span>
                        )}
                      </p>
                    )}
                    {round.gameType === 'flash_wcb' && (
                      <p className="text-sm text-foreground mb-2">
                        Flash word: <strong className="text-warning">"{String((round.roundData as any)?.targetWord ?? '')}"</strong>
                        <span className="text-muted ml-2">
                          {Math.round(Number((round.roundData as any)?.windowMs ?? 0) / 1000)}s window
                          {Boolean(round.roundData && (round.roundData as any).actualCount !== undefined) && (
                            <> · actual count: <strong className="text-foreground">{String((round.roundData as any).actualCount)}</strong></>
                          )}
                        </span>
                      </p>
                    )}
                    {round.gameType === 'user_word_bet' && (
                      <p className="text-sm text-foreground mb-2">
                        Word: <strong className="text-secondary">"{String((round.roundData as any)?.targetWord ?? '')}"</strong>
                        <span className="text-muted ml-2">
                          opened by {String((round.roundData as any)?.createdBy ?? 'member')}
                          {Boolean(round.roundData && (round.roundData as any).actualCount !== undefined) && (
                            <> · actual count: <strong className="text-foreground">{String((round.roundData as any).actualCount)}</strong></>
                          )}
                        </span>
                      </p>
                    )}
                    {round.gameType === 'bingo' && (
                      <p className="text-xs text-muted mb-2">
                        Round {String((round.roundData as any)?.roundNumber ?? '')} — first complete line wins.
                      </p>
                    )}
                    {/* Submissions */}
                    {round.submissions && round.submissions.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {round.submissions.map((s, i) => (
                          <span key={i} className="text-xs text-foreground bg-bg-elevated px-2 py-0.5 rounded-md">
                            {s.participantName}: <strong className="text-primary">{s.score > 0 ? `+${s.score}` : s.score}</strong>
                            {(s.submission as any)?.par && <span className="text-muted/60 ml-1">(par)</span>}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted italic">No submissions — no utterances received this round.</p>
                    )}
                    {/* Winner */}
                    {winner && winner.score > 0 && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-success">
                        <FiStar className="w-3.5 h-3.5" />
                        Winner: {winner.participantName} (+{winner.score})
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* 4. Leaderboard */}
        {leaderboard.length > 0 && (
          <section>
            <h2 className="text-sm font-heading font-semibold text-foreground mb-3 flex items-center gap-2">
              <FiStar className="w-4 h-4 text-warning" /> Leaderboard
            </h2>
            <div className="bg-bg-surface border border-border rounded-xl overflow-hidden">
              {leaderboard.map((e, i) => (
                <div key={e.participantId} className={`flex items-center gap-3 px-4 py-2.5 ${i === 0 ? 'bg-warning/10' : ''}`}>
                  <span className={`w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold flex-shrink-0 ${i === 0 ? 'bg-warning/20 text-warning' : 'bg-bg-elevated text-muted'}`}>
                    {i + 1}
                  </span>
                  <span className="flex-1 text-sm font-medium text-foreground">{e.participantName}</span>
                  <span className="text-xs text-muted">{e.pointsPerRound} pts/round · {e.roundsPlayed}r</span>
                  <span className="text-sm font-bold text-primary">{e.score}</span>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted/60 mt-1.5">Sorted by points per round, then total points.</p>
          </section>
        )}

        {/* 5. Key quotes */}
        {keyQuotes.length > 0 && (
          <section>
            <h2 className="text-sm font-heading font-semibold text-foreground mb-3 flex items-center gap-2">
              <FiMessageCircle className="w-4 h-4 text-secondary" /> Key Quotes
            </h2>
            <div className="space-y-2">
              {keyQuotes.slice(0, 5).map((q, i) => (
                <div key={i} className="bg-bg-surface border border-border rounded-xl px-4 py-3">
                  <p className="text-sm text-foreground italic">"{q.quote}"</p>
                  <p className="text-xs text-muted mt-1">
                    — {q.speakerName} · {q.correctGuesses}/{q.totalGuesses} guessed correctly
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Done — back to lobby */}
        <div className="pt-4 pb-8 print:hidden">
          <button
            onClick={onBack}
            className="w-full py-3.5 bg-primary hover:bg-primary-hover text-on-primary font-heading font-semibold rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-2 text-sm"
          >
            <FiChevronLeft className="w-4 h-4" />
            Back to lobby — start another meeting
          </button>
        </div>
      </div>
    </div>
  );
}

interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

/**
 * "Did you actually listen?" — auto-generated from the transcript.
 * Zero in-call distraction: it only exists on the recap page.
 */
function QuizSection({ questions }: { questions: QuizQuestion[] }) {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [revealed, setRevealed] = useState(false);

  const answered = Object.keys(answers).length;
  const score = questions.reduce(
    (acc, q) => (answers[q.id] === q.correctIndex ? acc + 1 : acc),
    0
  );

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-heading font-semibold text-foreground flex items-center gap-2">
          <FiMessageCircle className="w-4 h-4 text-secondary" /> Did you actually listen?
        </h2>
        {answered > 0 && (
          <span className="text-xs text-muted">{answered}/{questions.length} answered</span>
        )}
      </div>

      <div className="bg-bg-surface border border-border rounded-xl p-4 space-y-5">
        {questions.map((q, qi) => {
          const chosen = answers[q.id];
          const correct = chosen === q.correctIndex;
          const done = chosen !== undefined;
          return (
            <div key={q.id}>
              <p className="text-sm font-medium text-foreground mb-2">
                <span className="text-primary font-mono mr-1.5">{qi + 1}.</span>
                {q.prompt}
              </p>
              <div className="space-y-1.5">
                {q.options.map((opt, oi) => {
                  const isCorrect = oi === q.correctIndex;
                  const isChosen = chosen === oi;
                  let cls = 'bg-bg-elevated border-border text-foreground hover:bg-border/50';
                  if (done && isCorrect) cls = 'bg-success/15 border-success/50 text-success';
                  else if (done && isChosen && !isCorrect) cls = 'bg-destructive/15 border-destructive/50 text-destructive';
                  return (
                    <button
                      key={oi}
                      disabled={done}
                      onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: oi }))}
                      className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors cursor-pointer disabled:cursor-default ${cls}`}
                    >
                      <span className="font-mono mr-1.5">{String.fromCharCode(65 + oi)}</span>
                      {opt}
                      {done && isCorrect && <FiCheck className="inline w-3.5 h-3.5 ml-1.5" />}
                    </button>
                  );
                })}
              </div>
              {done && (
                <p className={`text-[11px] mt-1.5 ${correct ? 'text-success' : 'text-muted'}`}>
                  {correct ? '✓ Correct — ' : '✗ '}
                  {q.explanation}
                </p>
              )}
            </div>
          );
        })}

        {answered === questions.length && !revealed && (
          <button
            onClick={() => setRevealed(true)}
            className="w-full py-2.5 bg-primary hover:bg-primary-hover text-on-primary font-medium rounded-lg transition-colors cursor-pointer text-sm"
          >
            Reveal my score
          </button>
        )}
        {revealed && (
          <div className="text-center py-3 bg-bg-elevated border border-border rounded-lg">
            <p className="text-2xl font-heading font-bold text-primary">
              {score}/{questions.length}
            </p>
            <p className="text-xs text-muted mt-1">
              {score === questions.length
                ? 'Perfect — you were locked in! 🎯'
                : score >= questions.length / 2
                  ? 'Solid listening — half or better!'
                  : 'Multi-tasking much? 😄'}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
