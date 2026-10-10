// Dedicated sign-in / sign-up page — CLIENT SIDE.
//
// Why a page and not Clerk's modal (`openSignIn()`): a real route can be
// linked, bookmarked, and deep-linked to from emails. It also keeps the
// landing page free of account UI for guests who never want it.
//
// Route: #/signin  (see App.tsx). Rendered ONLY when accounts are configured —
// the route redirects to "/" when there is no publishable key, so a keyless
// build never shows a page it cannot complete.
//
// `<SignIn>` / `<SignUp>` must run INSIDE ClerkProvider (they read the Clerk
// context). AccountsProvider guarantees that; this component is only reachable
// underneath it.
//
// NO `routing` prop on purpose. This app owns the URL hash (HashRouter), and
// `routing="hash"` would ask Clerk to drive its own multi-step flow through
// that same hash — Clerk's steps (#/verify-email-address and friends) would be
// indistinguishable from app routes. Omitting `routing` keeps Clerk's steps in
// memory instead, so only this app ever writes to `#`.
//
// NOTE: not the cause of the blank-form report (that was Clerk still loading).
// Kept because the hash is genuinely contested otherwise.

import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SignIn, SignUp, useUser } from '@clerk/react';
import { clerkConfigured } from './AccountsProvider';

type Mode = 'signin' | 'signup';

/**
 * Where to send the user once Clerk finishes.
 *
 * The app uses HashRouter, so a plain "/" would land on the real site root and
 * lose the hash routing entirely. Send them back to the lobby hash instead,
 * or to the `next` param when something deep-linked them here.
 */
function useAfterAuthTarget(): string {
  const [params] = useSearchParams();
  const next = params.get('next');
  // Only allow same-app hash targets; never an absolute/external URL.
  if (next && next.startsWith('/')) return next;
  return '/';
}

export default function SignInPage() {
  const navigate = useNavigate();
  const { isLoaded, isSignedIn } = useUser();
  const [params, setParams] = useSearchParams();
  const afterAuth = useAfterAuthTarget();

  const modeParam = params.get('mode');
  const mode: Mode = modeParam === 'signup' ? 'signup' : 'signin';

  const setMode = (m: Mode) => {
    const nextParams = new URLSearchParams(params);
    nextParams.set('mode', m);
    setParams(nextParams, { replace: true });
  };

  // Already signed in? Don't show a sign-in form — bounce to the target.
  useEffect(() => {
    if (isLoaded && isSignedIn) navigate(afterAuth, { replace: true });
  }, [isLoaded, isSignedIn, afterAuth, navigate]);

  if (!clerkConfigured) return <KeylessNotice onBack={() => navigate('/', { replace: true })} />;

  return (
    <div className="min-h-screen w-screen flex flex-col bg-bg text-foreground">
      <header className="flex items-center justify-between px-6 py-4">
        <button
          onClick={() => navigate('/')}
          className="text-sm text-muted hover:text-foreground transition-colors cursor-pointer"
        >
          ← Back to MeetPlay
        </button>
        <ModeToggle mode={mode} onChange={setMode} />
      </header>

      <main className="flex-1 flex items-center justify-center px-4 pb-16">
        <div className="w-full max-w-md">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-semibold text-foreground">
              {mode === 'signin' ? 'Welcome back' : 'Create your account'}
            </h1>
            <p className="text-sm text-muted mt-1.5">
              {mode === 'signin'
                ? 'Sign in to tie your rooms to your account.'
                : 'An account is optional — you can always join as a guest.'}
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-bg-surface p-4">
            {mode === 'signin' ? (
              <SignIn
                withSignUp
                signUpUrl="#/signin?mode=signup"
                fallbackRedirectUrl={afterAuth}
              />
            ) : (
              <SignUp
                signInUrl="#/signin?mode=signin"
                fallbackRedirectUrl={afterAuth}
              />
            )}
          </div>

          <p className="text-[11px] text-muted text-center mt-4">
            Guests can keep using MeetPlay without an account. Signing in only links the rooms you
            create to you.
          </p>
        </div>
      </main>
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="flex items-center gap-1 p-0.5 rounded-full bg-bg-surface border border-border">
      {(['signin', 'signup'] as const).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={
            'px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ' +
            (mode === m ? 'bg-primary text-white' : 'text-muted hover:text-foreground')
          }
        >
          {m === 'signin' ? 'Sign in' : 'Sign up'}
        </button>
      ))}
    </div>
  );
}

/** Shown if someone deep-links to /signin in a build without a Clerk key. */
function KeylessNotice({ onBack }: { onBack: () => void }) {
  return (
    <div className="min-h-screen w-screen flex flex-col items-center justify-center gap-3 bg-bg text-foreground px-6">
      <h1 className="text-lg font-semibold">Sign-in isn't configured</h1>
      <p className="text-sm text-muted text-center max-w-sm">
        This build has no Clerk publishable key, so accounts are turned off. MeetPlay works fine as
        a guest.
      </p>
      <button
        onClick={onBack}
        className="mt-2 px-4 py-2 rounded-full bg-primary text-white text-sm font-medium cursor-pointer"
      >
        Back to the lobby
      </button>
    </div>
  );
}
