import { FiBarChart2, FiMic } from 'react-icons/fi';
import type { RoomStateSnapshot } from '../../types/games';

interface Props {
  stats: RoomStateSnapshot['stats'];
  participantId: string | null;
  quiet?: boolean;
}

/**
 * Um-O-Meter + share of voice. Pure passive stats from the transcript —
 * no interaction, just a glanceable panel showing who's talking how much
 * and who's leaning on filler words.
 */
export default function StatsPanel({ stats, participantId, quiet }: Props) {
  if (stats.length === 0) {
    return (
      <div className="p-6 text-center space-y-2">
        <div className="w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center mx-auto">
          <FiBarChart2 className="w-6 h-6 text-primary" />
        </div>
        <p className="text-sm text-foreground">Stats are warming up</p>
        <p className="text-xs text-muted">Talk a bit and the Um-O-Meter will light up.</p>
      </div>
    );
  }

  const maxFillers = Math.max(1, ...stats.map((s) => s.fillers));

  return (
    <div className={`p-4 space-y-4 ${quiet ? 'opacity-70' : ''}`}>
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted uppercase tracking-wider flex items-center gap-1.5">
          <FiBarChart2 className="w-3.5 h-3.5 text-primary" /> Share of Voice
        </h4>
        <span className="text-[10px] text-muted">live</span>
      </div>

      {/* Share of voice bars */}
      <div className="space-y-2">
        {stats.map((s) => (
          <div key={s.participantId} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className={`text-foreground truncate ${s.participantId === participantId ? 'font-semibold text-primary' : ''}`}>
                {s.participantName}
                {s.participantId === participantId && <span className="text-[10px] text-muted ml-1">(you)</span>}
              </span>
              <span className="text-muted font-mono">{s.shareOfVoice}%</span>
            </div>
            <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${s.participantId === participantId ? 'bg-primary' : 'bg-secondary/60'}`}
                style={{ width: `${Math.min(100, s.shareOfVoice)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Um-O-Meter */}
      <div className="border-t border-border pt-3">
        <div className="flex items-center gap-1.5 mb-2">
          <FiMic className="w-3.5 h-3.5 text-warning" />
          <h4 className="text-xs font-medium text-muted uppercase tracking-wider">Um-O-Meter</h4>
        </div>
        <div className="space-y-1.5">
          {stats
            .filter((s) => s.fillers > 0)
            .sort((a, b) => b.fillers - a.fillers)
            .slice(0, 6)
            .map((s) => (
              <div key={s.participantId} className="flex items-center gap-2 text-xs">
                <span className={`flex-1 truncate text-foreground ${s.participantId === participantId ? 'font-semibold text-primary' : ''}`}>
                  {s.participantName}
                  {s.participantId === participantId && <span className="text-[10px] text-muted ml-1">(you)</span>}
                </span>
                <div className="w-24 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                  <div
                    className="h-full bg-warning rounded-full transition-all duration-700"
                    style={{ width: `${(s.fillers / maxFillers) * 100}%` }}
                  />
                </div>
                <span className="font-mono text-muted w-7 text-right">{s.fillers}</span>
              </div>
            ))}
          {stats.every((s) => s.fillers === 0) && (
            <p className="text-xs text-muted italic">Zero filler words so far — very polished!</p>
          )}
        </div>
        <p className="text-[10px] text-muted/70 mt-2">
          "Most polished speaker" = fewest fillers per word. Awarded in the recap.
        </p>
      </div>
    </div>
  );
}
