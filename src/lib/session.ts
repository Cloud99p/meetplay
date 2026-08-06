// Session persistence — lets a user survive an accidental refresh without
// losing their place in the call.
//
// On create/join we snapshot the room context into sessionStorage (survives
// reload, dies when the tab closes). On app boot, if a snapshot exists and
// the room is still active, the user is put straight back into the meeting
// instead of being dumped at the lobby with no way back except the link.

export interface SessionSnapshot {
  roomId: string;
  participantId: string;
  participantName: string;
  isHost: boolean;
  livekitUrl: string;
  token: string;
  password?: string; // only stored in-session (sessionStorage) for password rooms
  savedAt: number;
}

const SESSION_KEY = 'meetplay_session_snapshot';

export function saveSessionSnapshot(snap: Omit<SessionSnapshot, 'savedAt'>): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...snap, savedAt: Date.now() }));
  } catch {
    /* storage full/blocked — non-fatal */
  }
}

export function getSessionSnapshot(): SessionSnapshot | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionSnapshot;
    if (!parsed.roomId || !parsed.participantId || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Drop the snapshot when the user deliberately leaves the meeting. */
export function clearSessionSnapshot(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
