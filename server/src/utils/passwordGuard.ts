/**
 * Server-side password attempt guard (per room + IP).
 *
 * The join form's client-side lockout is cosmetic — a refresh or a direct
 * API call bypasses it. This module enforces a REAL lockout in roomsRoutes:
 * after MAX_ATTEMPTS failed password tries for a room from one IP, further
 * attempts from that IP are rejected with 429 until the lockout expires.
 *
 * Note: this complements (not replaces) the global @fastify/rate-limit
 * (120 req/min/IP). That global limit still allowed ~120 password guesses
 * per minute per room; this guard cuts it to 5, with an escalating
 * cooldown, scoped to the exact room being attacked.
 *
 * Tunables (env):
 *   PASSWORD_MAX_ATTEMPTS   default 5
 *   PASSWORD_LOCKOUT_MS     default 15 min
 */

interface AttemptRecord {
  fails: number;
  firstFailAt: number;
  lockedUntil: number; // 0 = not locked
}

const MAX_ATTEMPTS = Number(process.env.PASSWORD_MAX_ATTEMPTS ?? 5);
const LOCKOUT_MS = Number(process.env.PASSWORD_LOCKOUT_MS ?? 15 * 60 * 1000);
const PRUNE_MS = 30 * 60 * 1000;

// key: `${roomId}:${ip}`
const attempts = new Map<string, AttemptRecord>();
let lastPrune = Date.now();

function key(roomId: string, ip: string): string {
  return `${roomId}:${ip}`;
}

function prune(): void {
  const now = Date.now();
  if (now - lastPrune < PRUNE_MS) return;
  lastPrune = now;
  for (const [k, rec] of attempts) {
    // Records idle for > 1h (no fails since, and lockout expired) are junk.
    if (now - rec.firstFailAt > 60 * 60 * 1000 && rec.lockedUntil < now) {
      attempts.delete(k);
    }
  }
}

/**
 * Check whether a password attempt is currently allowed for room+IP.
 * Returns { allowed: true } or { allowed: false, retryAfterMs }.
 */
export function checkPasswordAttempt(roomId: string, ip: string): {
  allowed: boolean;
  retryAfterMs?: number;
} {
  prune();
  const rec = attempts.get(key(roomId, ip));
  if (!rec) return { allowed: true };
  const now = Date.now();
  if (rec.lockedUntil > now) {
    return { allowed: false, retryAfterMs: rec.lockedUntil - now };
  }
  // Only reset the record when a PREVIOUS lockout has actually expired
  // (lockedUntil was set in the past). A record with lockedUntil=0 is just
  // an in-progress fail count — deleting it here would wipe the count on
  // every attempt and the lockout could never trigger.
  if (rec.lockedUntil > 0) {
    attempts.delete(key(roomId, ip));
  }
  return { allowed: true };
}

/** Record a failed password attempt; returns true if this failure triggers a lockout. */
export function recordPasswordFailure(roomId: string, ip: string): boolean {
  prune();
  const k = key(roomId, ip);
  const now = Date.now();
  const rec = attempts.get(k) ?? { fails: 0, firstFailAt: now, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
    rec.fails = 0; // reset count; next failed attempt after lockout re-arms
  }
  attempts.set(k, rec);
  return rec.lockedUntil > now;
}

/** Clear the record after a successful join (good hygiene, prevents lockout follow-through). */
export function clearPasswordAttempts(roomId: string, ip: string): void {
  attempts.delete(key(roomId, ip));
}

/** Exposed for tests. */
export function _passwordGuardState(): { size: number; maxAttempts: number; lockoutMs: number } {
  return { size: attempts.size, maxAttempts: MAX_ATTEMPTS, lockoutMs: LOCKOUT_MS };
}
