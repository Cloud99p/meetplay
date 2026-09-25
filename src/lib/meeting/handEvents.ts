/**
 * Turns participant-list changes into hand-raise announcements.
 *
 * Why a diff rather than the `hand:raised` broadcast: the broadcast tells you
 * something happened, but not what the room's hand state now IS, so a dropped
 * frame leaves the UI wrong with no way to notice. Diffing the participant list
 * - which is the derived, server-seeded truth - means the announcement follows
 * the state everyone actually sees, and a resync can never produce a phantom
 * "raised" (the hand is already up; there is no transition).
 */

export interface ParticipantLike {
  id: string;
  name: string;
  handRaised: boolean;
}

export interface HandAnnouncement {
  /** Stable key for rendering and dismissal. */
  id: string;
  participantId: string;
  name: string;
  action: 'raised' | 'lowered';
  /** True when the announcement is about the person looking at the screen. */
  isSelf: boolean;
  at: number;
}

export function diffHands(
  prev: ParticipantLike[],
  next: ParticipantLike[],
  selfId?: string | null,
  now: number = Date.now()
): HandAnnouncement[] {
  const before = new Map(prev.map((p) => [p.id, p.handRaised] as const));
  const out: HandAnnouncement[] = [];

  for (const p of next) {
    // No previous knowledge of this participant — a first snapshot, a late join,
    // or a resync that recreated the entry. Stay silent: announcing here would
    // fire a toast for every hand already up the moment the list loads.
    if (!before.has(p.id)) continue;

    const was = before.get(p.id) === true;
    if (p.handRaised === was) continue;

    out.push({
      id: `${p.id}-${p.handRaised ? 'raised' : 'lowered'}-${now}`,
      participantId: p.id,
      name: p.name,
      action: p.handRaised ? 'raised' : 'lowered',
      isSelf: Boolean(selfId) && p.id === selfId,
      at: now,
    });
  }

  return out;
}
