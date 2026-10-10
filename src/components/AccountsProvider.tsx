// Clerk provider wiring — CLIENT SIDE.
//
// The app must render EXACTLY as before when accounts are unconfigured. A fresh
// clone, the in-memory dev env, or any build without VITE_CLERK_PUBLISHABLE_KEY
// should boot to the normal guest experience — never a white screen, never a
// crash. That is why the provider is mounted conditionally rather than always.

import { useEffect, type ReactNode } from 'react';
import { ClerkProvider, useAuth } from '@clerk/react';
import { setTokenGetter } from '../lib/auth';

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

/** True when this build has a publishable key, i.e. sign-in can be offered. */
export const clerkConfigured = Boolean(PUBLISHABLE_KEY);

/**
 * Registers Clerk's token getter with the framework-free `api.ts` layer.
 *
 * Must live INSIDE the provider (needs `useAuth`). Fetched via the callback
 * rather than read once, because Clerk session tokens are short-lived.
 */
function TokenBridge() {
  const { getToken } = useAuth();
  useEffect(() => {
    setTokenGetter(() => getToken());
    return () => setTokenGetter(null);
  }, [getToken]);
  return null;
}

/**
 * Wrap the app in a ClerkProvider ONLY when configured.
 *
 * `afterSignOutUrl` returns the user to the lobby. No router is used by this
 * app (it switches views on state), so a full reload is the correct reset.
 */
export function AccountsProvider({ children }: { children: ReactNode }) {
  if (!clerkConfigured) return <>{children}</>;
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
      <TokenBridge />
      {children}
    </ClerkProvider>
  );
}
