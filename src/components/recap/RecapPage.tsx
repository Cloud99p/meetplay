import { useState, useEffect } from 'react';
import * as api from '../../lib/api';
import type { RecapData } from '../../lib/api';
import { FiClock, FiMessageSquare, FiAward, FiUsers, FiChevronLeft } from 'react-icons/fi';

interface Props {
  roomId: string;
  onBack: () => void;
}

export default function RecapPage({ roomId, onBack }: Props) {
  const [recap, setRecap] = useState<RecapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const data = await api.getRecap(roomId);
        setRecap(data);
      } catch (e: any) {
        setError(e?.message ?? 'Failed to load recap');
      } finally {
        setLoading(false);
      }
    })();
  }, [roomId]);

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

  return (
    <div className="min-h-screen bg-bg-base">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="p-2 rounded-lg hover:bg-bg-elevated text-muted hover:text-foreground transition-colors cursor-pointer">
            <FiChevronLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-heading font-bold text-foreground">Meeting Recap</h1>
            <p className="text-xs text-muted">
              {recap.room.name || 'Untitled Room'} · {new Date(recap.room.createdAt).toLocaleDateString()}
            </p>
          </div>
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
            <p className="text-2xl font-heading font-bold text-foreground">{Math.floor(recap.room.duration / 60)}m</p>
            <p className="text-xs text-muted">Duration</p>
          </div>
          <div className="bg-bg-surface border border-border rounded-xl p-4 text-center">
            <FiAward className="w-5 h-5 text-accent mx-auto mb-1" />
            <p className="text-2xl font-heading font-bold text-foreground">{recap.gameRounds.length}</p>
            <p className="text-xs text-muted">Game Rounds</p>
          </div>
        </div>

        {/* Who played */}
        <div>
          <h2 className="text-sm font-heading font-semibold text-foreground mb-3 flex items-center gap-2">
            <FiUsers className="w-4 h-4 text-primary" /> Participants
          </h2>
          <div className="flex flex-wrap gap-2">
            {recap.participants.map((p) => (
              <span key={p.id} className="px-3 py-1 bg-bg-elevated rounded-full text-xs text-foreground">
                {p.name}{p.isHost ? ' (Host)' : ''}
              </span>
            ))}
          </div>
        </div>

        {/* Game rounds */}
        {recap.gameRounds.length > 0 && (
          <div>
            <h2 className="text-sm font-heading font-semibold text-foreground mb-3 flex items-center gap-2">
              <FiAward className="w-4 h-4 text-accent" /> Game Rounds
            </h2>
            <div className="space-y-3">
              {recap.gameRounds.map((round) => (
                <div key={round.id} className="bg-bg-surface border border-border rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-primary uppercase tracking-wider">{round.gameType}</span>
                    <span className="text-[10px] text-muted">
                      {new Date(round.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  {round.submissions && (
                    <div className="flex flex-wrap gap-2">
                      {round.submissions.map((s, i) => (
                        <span key={i} className="text-xs text-foreground bg-bg-elevated px-2 py-0.5 rounded-md">
                          {s.participantName}: <strong className="text-primary">{s.score > 0 ? `+${s.score}` : s.score}</strong>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Transcript (if consented) */}
        {recap.transcript && recap.transcript.length > 0 && (
          <div>
            <h2 className="text-sm font-heading font-semibold text-foreground mb-3 flex items-center gap-2">
              <FiMessageSquare className="w-4 h-4 text-secondary" /> Transcript
            </h2>
            <div className="bg-bg-surface border border-border rounded-xl p-4 max-h-80 overflow-y-auto space-y-2">
              {recap.transcript.map((t) => (
                <div key={t.id} className="flex gap-2 text-sm">
                  <span className="font-medium text-primary flex-shrink-0">{t.participantName}:</span>
                  <span className="text-foreground">{t.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty transcript notice */}
        {(!recap.transcript || recap.transcript.length === 0) && (
          <div className="bg-bg-surface border border-border rounded-xl p-6 text-center">
            <FiMessageSquare className="w-8 h-8 text-muted/40 mx-auto mb-2" />
            <p className="text-sm text-muted">No transcript available for this meeting.</p>
            <p className="text-xs text-muted/60 mt-1">Transcripts are only recorded when captions are enabled.</p>
          </div>
        )}
      </div>
    </div>
  );
}