// Authenticated home — the page a signed-in user lands on.
//
// Flow this serves (per the agreed routing):
//   landing (#/)  ->  sign in / sign up  ->  #/dashboard  ->  "Create Call Room"
//   ->  #/rooms (name + password)  ->  #/meeting/:id
//
// Room history is real: it reads GET /api/rooms (server filters on
// owner_user_id, which only a verified Bearer token can set), so the list
// cannot show anyone else's rooms. A guest or brand-new account gets an empty
// list, which renders as a single quiet line rather than a fake empty state.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FiPlus, FiLogOut, FiVideo, FiLock, FiClock } from 'react-icons/fi';
import { useClerk, useUser } from '@clerk/react';
import { clerkConfigured } from './AccountsProvider';
import * as api from '../lib/api';

/** Guest fallback when this build has no Clerk key — never render user hooks. */
export default function DashboardPage() {
  if (!clerkConfigured) return <DashboardGuest />;
  return <DashboardConfigured />;
}

function DashboardGuest() {
  return (
    <Shell
      title="Accounts aren't configured"
      subtitle="This build has no Clerk publishable key, so there is no account to show."
      action={{ label: 'Create a room as guest', onClick: undefined }}
    />
  );
}

function DashboardConfigured() {
  const navigate = useNavigate();
  const { signOut } = useClerk();
  const { isLoaded, isSignedIn, user } = useUser();

  if (!isLoaded) {
    return (
      <div className="min-h-screen bg-bg-base flex items-center justify-center">
        <div className="w-10 h-10 rounded-full border-4 border-border border-t-primary animate-spin" />
      </div>
    );
  }

  if (!isSignedIn) {
    // Guard race: the route guard normally catches this, but if a session
    // ends while this page is open, send them back to the landing page.
    navigate('/', { replace: true });
    return null;
  }

  const name = user?.firstName || user?.username || user?.primaryEmailAddress?.emailAddress || 'there';

  return (
    <div className="min-h-screen bg-bg-base">
      {/* Top bar */}
      <div className="fixed top-4 right-4 flex items-center gap-2">
        <button
          onClick={() => void signOut({ redirectUrl: '/' })}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bg-surface border border-border hover:bg-bg-elevated transition-colors cursor-pointer text-xs font-medium text-foreground"
        >
          <FiLogOut className="w-3.5 h-3.5 text-muted" />
          Sign out
        </button>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-16">
        <div className="flex items-center gap-3 mb-2">
          <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-primary/20">
            <FiVideo className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-heading font-bold text-foreground">
              Welcome, {name}
            </h1>
            <p className="text-sm text-muted">Start a meeting or join one.</p>
          </div>
        </div>

        {/* Primary action: the one thing the API supports today. */}
        <button
          onClick={() => navigate('/rooms')}
          className="mt-8 w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-primary text-white font-medium hover:opacity-90 transition-opacity cursor-pointer"
        >
          <FiPlus className="w-5 h-5" />
          Create Call Room
        </button>

        {/* The one action the API supports today. */}
        <button
          onClick={() => navigate('/rooms')}
          className="mt-8 w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-primary text-white font-medium hover:opacity-90 transition-opacity cursor-pointer"
        >
          <FiPlus className="w-5 h-5" />
          Create Call Room
        </button>

        <RoomHistory />
      </div>
    </div>
  );
}

/**
 * The signed-in user's recent rooms, from GET /api/rooms.
 *
 * Deliberately shows nothing but a quiet line when the list is empty (a new
 * account, or a guest) — an empty "no rooms yet" card would be noise on first
 * load. Also no retry button: a failed load is logged, not surfaced as a
 * blocking error, because the primary action (Create) is above and works
 * regardless.
 */
function RoomHistory() {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<api.MyRoom[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listMyRooms()
      .then((r) => {
        if (!cancelled) setRooms(r);
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error('room history failed', e);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return null;

  if (rooms === null) {
    return (
      <div className="mt-8 flex justify-center">
        <div className="w-6 h-6 rounded-full border-4 border-border border-t-primary animate-spin" />
      </div>
    );
  }

  if (rooms.length === 0) {
    return (
      <p className="mt-8 text-center text-sm text-muted">
        Your rooms will appear here after you create one.
      </p>
    );
  }

  return (
    <div className="mt-8">
      <h2 className="text-sm font-medium text-muted mb-3">Your rooms</h2>
      <div className="space-y-2">
        {rooms.map((r) => (
          <button
            key={r.id}
            onClick={() => navigate(`/join/${r.id}`)}
            className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-bg-surface border border-border hover:bg-bg-elevated transition-colors cursor-pointer text-left"
          >
            <span className="text-sm text-foreground truncate">
              {r.name || 'Untitled room'}
            </span>
            <span className="flex items-center gap-3 shrink-0 ml-3">
              {r.hasPassword && <FiLock className="w-3.5 h-3.5 text-muted" />}
              <span className="flex items-center gap-1 text-xs text-muted">
                <FiClock className="w-3 h-3" />
                {new Date(r.createdAt).toLocaleDateString()}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Shell({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action: { label: string; onClick?: () => void };
}) {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-bg-base flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center">
        <h1 className="text-xl font-heading font-bold text-foreground">{title}</h1>
        <p className="text-sm text-muted mt-2">{subtitle}</p>
        <button
          onClick={action.onClick ?? (() => navigate('/rooms'))}
          className="mt-6 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-medium hover:opacity-90 transition-opacity cursor-pointer"
        >
          {action.label}
        </button>
      </div>
    </div>
  );
}
