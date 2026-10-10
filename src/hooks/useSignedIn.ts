// Auth state for ROUTE GATING — client side.
//
// Wraps Clerk's `useAuth` so route logic has ONE place to ask "is this visitor
// signed in?". The critical property: this must be safe to call even when Clerk
// is unconfigured (no publishable key). `useAuth` throws outside a
// ClerkProvider, so when `clerkConfigured` is false we must NOT call it —
// `useSignedIn` therefore branches BEFORE the hook call rather than after.

import { useAuth } from '@clerk/react';
import { clerkConfigured } from '../components/AccountsProvider';

export interface AuthState {
  /** True while Clerk is still resolving its session cookie. */
  loading: boolean;
  /** True once Clerk confirms an active session. Always false for guests. */
  signedIn: boolean;
  /** False when this build has no publishable key (sign-in impossible). */
  configured: boolean;
}

/**
 * Read the caller's sign-in state.
 *
 * When Clerk is unconfigured there is no session to resolve, so we return a
 * settled guest state (`loading: false`) — NOT `loading: true`, which would
 * hang any guard that waits for `loading` to clear.
 */
export function useSignedIn(): AuthState {
  if (!clerkConfigured) {
    return { loading: false, signedIn: false, configured: false };
  }
  return useSignedInConfigured();
}

/** Same contract, but only called when a ClerkProvider exists. */
function useSignedInConfigured(): AuthState {
  const { isLoaded, isSignedIn } = useAuth();
  return {
    loading: !isLoaded,
    signedIn: Boolean(isSignedIn),
    configured: true,
  };
}
