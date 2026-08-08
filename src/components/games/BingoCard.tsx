import { FiGrid, FiAward } from 'react-icons/fi';
import type { RoomStateSnapshot } from '../../types/games';
import { BINGO_SIZE } from '../../lib/games/bingo';

interface Props {
  bingo: NonNullable<RoomStateSnapshot['bingo']>;
  participantId: string | null;
  quiet?: boolean;
}

/**
 * Buzzword Bingo — passive, auto-marked from the transcript.
 * Your 5×5 card fills in as people say the words; first complete line wins.
 */
export default function BingoCard({ bingo, participantId, quiet }: Props) {
  const { myCard, myMarks, winner, roundNumber } = bingo;
  const markSet = new Set(myMarks);
  const iWon = winner?.participantId === participantId;

  return (
    <div className={`w-full min-w-0 max-w-full p-4 space-y-3 border-b border-border ${quiet ? 'opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <h4 className="text-xs font-medium text-muted uppercase tracking-wider flex items-center gap-1.5 flex-wrap">
          <FiGrid className="w-3.5 h-3.5 text-secondary" /> Buzzword Bingo
          <span className="text-[10px] font-normal text-muted bg-bg-elevated px-1.5 py-0.5 rounded-full">round {roundNumber}</span>
        </h4>
        <span className="text-[10px] text-muted">{markSet.size}/{myCard.length} marked</span>
      </div>

      {winner && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium ${
          iWon ? 'bg-success/15 text-success border border-success/30' : 'bg-bg-elevated border border-border text-foreground'
        }`}>
          <FiAward className="w-4 h-4 flex-shrink-0" />
          {iWon ? 'BINGO! You got it — new card coming…' : `${winner.participantName} hit BINGO! New card coming…`}
        </div>
      )}

      {myCard.length === 0 ? (
        <p className="text-xs text-muted italic">Card is being dealt…</p>
      ) : (
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${BINGO_SIZE}, 1fr)` }}
        >
          {myCard.map((word, i) => {
            const marked = markSet.has(i);
            const inWinLine = winner?.participantId === participantId && false;
            return (
              <div
                key={i}
                title={word}
                className={`flex items-center justify-center text-center rounded-md px-1 py-2 min-h-9 text-[10px] font-medium leading-tight transition-colors ${
                  marked
                    ? 'bg-secondary/20 text-secondary border border-secondary/40'
                    : inWinLine
                      ? 'bg-success/20 text-success border border-success/40'
                      : 'bg-bg-elevated border border-border text-foreground'
                }`}
              >
                {word}
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[10px] text-muted/70">
        Words mark themselves as people say them — no clicking needed.
      </p>
    </div>
  );
}
