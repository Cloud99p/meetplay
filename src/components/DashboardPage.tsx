// Authenticated home — the page a signed-in user lands on.
//
// Flow this serves (per the agreed routing):
//   landing (#/)  ->  sign in / sign up  ->  #/dashboard  ->  "Create Call Room"
//   ->  #/rooms (name + password)  ->  #/meeting/:id
//
// There is no "list my past rooms" endpoint on the server (the API exposes
// POST /api/rooms and GET /api/rooms/:id, but no collection GET), so this page
// deliberately does NOT fake a room history. It offers the one action the API
// genuinely supports and leaves a marked slot for features to come.

import { useNavigate } from 'react-router-dom';
import { FiPlus, FiLogOut, FiVideo } from 'react-icons/fi';
import { useClerk, useUser } from '@clerk/react';
import { clerkConfigured } from './AccountsProvider';

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

        {/* Reserved for features to come (room history needs a server
            endpoint that does not exist yet — see file header). */}
        <div className="mt-8 rounded-2xl border border-dashed border-border p-6 text-center">
          <p className="text-sm text-muted">
            More features will live here — recent rooms, contacts, meeting history.
          </p>
        </div>
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
