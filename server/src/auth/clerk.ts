// Clerk authentication — SERVER SIDE.
//
// DESIGN CONSTRAINTS (read before changing):
//
//  1. Accounts are OPTIONAL. `README.md` decision #5: a guest joins with just a
//     display name, and a shared link must keep working. Clerk layers ON TOP of
//     guest identity; it must never become a gate in front of joining. Every
//     helper here therefore has a "no identity" branch that callers treat as
//     normal, not as an error.
//
//  2. Accounts are OFF when unconfigured. With no CLERK_SECRET_KEY the whole
//     module degrades to `{ userId: null }` instead of throwing, so a fresh
//     clone (or the in-memory dev env) boots with guest-only behaviour rather
//     than a broken app.
//
//  3. `users.clerk_user_id` is the join key and is UNIQUE. There is no webhook
//     yet, so rows are created lazily on the first authenticated request; the
//     UNIQUE constraint is what makes a retried or concurrent create safe
//     (insert-one-wins, loser re-reads) instead of splitting one person into
//     two accounts with their rooms on different rows.
//
//  4. This mirrors the existing room-token design: identity is proven per
//     REQUEST, never trusted from the body. `body.userId` remains a guest
//     hint; only a verified Clerk token can set `owner_user_id`.

import { createClerkClient, verifyToken } from '@clerk/backend';
import { upsertUserByClerkId, getUserByClerkId } from '../db/queries.js';

/** Clerk is configured? Without a secret key, accounts are simply unavailable. */
export function clerkEnabled(): boolean {
  return Boolean(process.env.CLERK_SECRET_KEY);
}

const clerk = clerkEnabled()
  ? createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! })
  : null;

export interface AuthedIdentity {
  /** Clerk user id (`user_...`) when a valid session token was presented, else null. */
  clerkUserId: string | null;
  /** Local `users.id` (uuid). Only set once the row exists. */
  userId: string | null;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
}

const ANONYMOUS: AuthedIdentity = {
  clerkUserId: null,
  userId: null,
  email: null,
  name: null,
  imageUrl: null,
};

/**
 * Verify a Clerk session token from the `Authorization: Bearer <jwt>` header.
 *
 * Never throws: an absent, malformed, expired or forged token all resolve to
 * `ANONYMOUS`. That is deliberate — guest joins must not 401, and a broken
 * token should degrade to guest rather than break the meeting they're in.
 */
export async function identify(
  authorizationHeader: string | undefined,
  log?: { warn: (o: unknown, m?: string) => void },
): Promise<AuthedIdentity> {
  if (!clerkEnabled()) return ANONYMOUS;

  const raw = authorizationHeader ?? '';
  const token = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : '';
  if (!token) return ANONYMOUS;

  // A guest-supplied userId is NOT a token. Reject anything that isn't a JWT so
  // a random string can't be mistaken for a verified identity.
  if (token.split('.').length !== 3) return ANONYMOUS;

  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    });
    const clerkUserId = (payload as { sub?: string }).sub;
    if (!clerkUserId) return ANONYMOUS;

    // The token carries identity but not profile data. Fetch it so name/email
    // stay a faithful cache of Clerk's copy (the source of truth).
    let email: string | null = null;
    let name: string | null = null;
    let imageUrl: string | null = null;
    try {
      const user = await clerk!.users.getUser(clerkUserId);
      email =
        user.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)
          ?.emailAddress ?? user.emailAddresses?.[0]?.emailAddress ?? null;
      name =
        [user.firstName, user.lastName].filter(Boolean).join(' ') ||
        user.username ||
        null;
      imageUrl = user.imageUrl ?? null;
    } catch (e) {
      // Profile lookup is a cache refresh, not a gate: a Clerk hiccup must not
      // lock a signed-in user out of their own meeting.
      log?.warn({ err: e }, '[clerk] profile lookup failed — using token identity only');
    }

    // Lazy upsert. Safe under concurrency thanks to the UNIQUE constraint.
    const row = await upsertUserByClerkId({ clerkUserId, email, name, imageUrl });

    return { clerkUserId, userId: row?.id ?? null, email, name, imageUrl };
  } catch (e) {
    log?.warn({ err: e }, '[clerk] token verification failed — treating as guest');
    return ANONYMOUS;
  }
}

/**
 * Read the identity for a request WITHOUT creating a `users` row.
 *
 * Used on read paths (room list, recap) so that merely *looking* at something
 * never writes to the database.
 */
export async function identifyReadOnly(
  authorizationHeader: string | undefined,
): Promise<AuthedIdentity> {
  if (!clerkEnabled()) return ANONYMOUS;
  const raw = authorizationHeader ?? '';
  const token = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : '';
  if (!token || token.split('.').length !== 3) return ANONYMOUS;
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    });
    const clerkUserId = (payload as { sub?: string }).sub ?? null;
    if (!clerkUserId) return ANONYMOUS;
    const row = await getUserByClerkId(clerkUserId);
    return {
      clerkUserId,
      userId: row?.id ?? null,
      email: row?.email ?? null,
      name: row?.name ?? null,
      imageUrl: row?.image_url ?? null,
    };
  } catch {
    return ANONYMOUS;
  }
}
