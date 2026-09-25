import { useEffect } from 'react';
import { LuHand } from 'react-icons/lu';
import type { HandAnnouncement } from '../../lib/meeting/handEvents';

/** How long an announcement stays on screen before it fades itself out. */
const AUTO_DISMISS_MS = 5000;

interface Props {
  announcements: HandAnnouncement[];
  onDismiss: (id: string) => void;
}

/**
 * The visible half of raising a hand.
 *
 * A small glyph on a tile is far too easy to miss, which is the whole reason
 * this exists: when someone raises their hand the room should not have to spot
 * a 3px icon. Each announcement names the person, animates in, and can be
 * clicked away early.
 */
export default function HandRaiseToasts({ announcements, onDismiss }: Props) {
  // One timer per announcement so a burst (two people raising together) fades
  // out on its own schedule instead of the newest resetting everyone's clock.
  useEffect(() => {
    if (announcements.length === 0) return;
    const timers = announcements.map((a) => setTimeout(() => onDismiss(a.id), AUTO_DISMISS_MS));
    return () => timers.forEach((t) => clearTimeout(t));
  }, [announcements, onDismiss]);

  if (announcements.length === 0) return null;

  return (
    <div
      className="absolute top-16 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-2 pointer-events-none"
      role="status"
      aria-live="polite"
    >
      {announcements.map((a) => {
        const label = a.isSelf
          ? a.action === 'raised'
            ? 'You raised your hand'
            : 'You lowered your hand'
          : `${a.name} ${a.action === 'raised' ? 'raised their hand' : 'lowered their hand'}`;
        return (
          <button
            key={a.id}
            onClick={() => onDismiss(a.id)}
            title="Dismiss"
            className={`pointer-events-auto flex items-center gap-2 px-3.5 py-2 rounded-full shadow-lg text-sm font-medium cursor-pointer ${
              a.action === 'raised'
                ? 'bg-secondary text-on-secondary'
                : 'bg-bg-elevated text-foreground'
            }`}
          >
            <LuHand className={`w-4 h-4 ${a.action === 'raised' ? 'animate-pulse' : ''}`} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
