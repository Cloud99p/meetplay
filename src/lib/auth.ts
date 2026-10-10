// Account layer — CLIENT SIDE.
//
// DESIGN CONSTRAINTS (mirror server/src/auth/clerk.ts):
//
//  1. Accounts are OPTIONAL. `README.md` decision #5: a guest joins with just a
//     display name. Everything here degrades to "no account" rather than
//     blocking a join, so the app works identically with Clerk unconfigured.
//
//  2. Clerk is loaded ONLY when a publishable key is present. `VITE_CLERK_*` is
//     baked in at build time; with no key the provider is skipped entirely and
//     the app renders exactly as it did before accounts existed. A missing key
//     must never white-screen the app.
//
//  3. `api.ts` stays framework-free. Rather than import Clerk into the request
//     helper, this module registers a token getter with it — so the API layer
//     knows nothing about Clerk and remains usable in tests.

let tokenGetter: (() => Promise<string | null>) | null = null;

/**
 * Register the function `api.ts` uses to fetch a fresh Clerk session token.
 *
 * Clerk session tokens are SHORT-LIVED, so this must be called per request
 * rather than caching a string — an expired token would otherwise be sent and
 * the request would silently degrade to guest.
 */
export function setTokenGetter(fn: (() => Promise<string | null>) | null): void {
  tokenGetter = fn;
}

/** Current session token, or null when signed out / accounts unconfigured. */
export async function getSessionToken(): Promise<string | null> {
  if (!tokenGetter) return null;
  try {
    return await tokenGetter();
  } catch {
    // A failed token fetch must never break the request: fall through to
    // guest behaviour, matching the server's "never 401 a guest" rule.
    return null;
  }
}

/** Is account sign-in possible in this build? (publishable key present) */
export function accountsEnabled(): boolean {
  return Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
}
