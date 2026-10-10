// Account menu for the lobby — CLIENT SIDE.
//
// Renders the visitor's account state in the lobby corner, beside the theme
// toggle. Two hard rules, both from `README.md` decision #5:
//
//  1. GUESTS SEE NOTHING INTRUSIVE. Signed out, this is a single quiet
//     "Sign in" button. It never blocks creating or joining a room, and it is
//     absent entirely when the module has no publishable key.
//
//  2. ACCOUNTS NEVER GATE A JOIN. Sign-in is an optional upgrade for people who
//     want their rooms tied to an account; a guest with just a display name is
//     the primary path, not a fallback.
//
// `useUser` must run INSIDE ClerkProvider, so this component is only rendered
// when accounts are configured (see AccountsProvider). Rendering it without a
// provider throws.

import { useEffect, useRef, useState } from 'react';
import { useClerk, useUser } from '@clerk/react';
import { FiUser, FiLogOut, FiChevronDown } from 'react-icons/fi';

/** Tell the server "I'm signed in" so it can materialise the local users row. */
async function syncWithServer(): Promise<void> {
  try {
    await fetch('/api/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch {
    // A failed sync is not fatal: the row is created lazily on the next
    // authenticated request (e.g. room create). Never surface this to the user.
  }
}

function SignedInMenu({ name, imageUrl, email }: { name: string; imageUrl?: string; email?: string }) {
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape — standard menu behaviour.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-full bg-bg-surface border border-border hover:bg-bg-elevated transition-colors cursor-pointer"
        title={email ?? name}
      >
        {imageUrl ? (
          <img src={imageUrl} alt="" className="w-6 h-6 rounded-full object-cover" />
        ) : (
          <span className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center">
            <FiUser className="w-3.5 h-3.5" />
          </span>
        )}
        <span className="text-xs font-medium text-foreground max-w-[100px] truncate">{name}</span>
        <FiChevronDown className="w-3 h-3 text-muted" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-52 bg-bg-surface border border-border rounded-xl shadow-lg overflow-hidden"
        >
          <div className="px-3 py-2.5 border-b border-border">
            <p className="text-xs font-medium text-foreground truncate">{name}</p>
            {email && <p className="text-[10px] text-muted truncate mt-0.5">{email}</p>}
          </div>
          {/* Rooms you create are linked to this account. */}
          <button
            role="menuitem"
            onClick={() => signOut()}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-foreground hover:bg-bg-elevated transition-colors cursor-pointer"
          >
            <FiLogOut className="w-3.5 h-3.5 text-muted" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function SignedOutButton() {
  const { openSignIn } = useClerk();
  return (
    <button
      onClick={() => openSignIn()}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bg-surface border border-border hover:bg-bg-elevated transition-colors cursor-pointer"
    >
      <FiUser className="w-3.5 h-3.5 text-muted" />
      <span className="text-xs font-medium text-foreground">Sign in</span>
    </button>
  );
}

export default function AccountMenu() {
  const { isLoaded, isSignedIn, user } = useUser();

  // Once a session exists, tell the server so the users row is materialised
  // before any room is created. Runs on sign-in, not on every render.
  useEffect(() => {
    if (isLoaded && isSignedIn) void syncWithServer();
  }, [isLoaded, isSignedIn]);

  // Render nothing until Clerk has resolved, so the button doesn't flash
  // "Sign in" for someone who is already signed in.
  if (!isLoaded) return null;

  if (!isSignedIn || !user) return <SignedOutButton />;

  const name =
    [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Account';
  return (
    <SignedInMenu
      name={name}
      imageUrl={user.imageUrl}
      email={user.primaryEmailAddress?.emailAddress}
    />
  );
}
