// HomePage — the product-first landing draft.
//
// Design brief from Cloud: "closer to Google Classroom — the product is the
// main seller... plainly easy to create a room without getting overwhelmed."
//
// So this is deliberately NOT a marketing hero. It is a workspace:
//   - left rail = navigation + secondary pages (secondary, never blocking)
//   - main canvas = one obvious action (create), with join right beside it
//   - rooms list = only when you actually have rooms
//
// Everything above the fold is something you can click. No feature grid, no
// comparison table, no scroll to find the button.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FiPlus,
  FiVideo,
  FiLogIn,
  FiCopy,
  FiCheck,
  FiClock,
  FiArrowRight,
  FiLock,
  FiChevronDown,
} from 'react-icons/fi';
import * as api from '../lib/api';
import ThemeToggle from './ThemeToggle';
import AccountMenu from './AccountMenu';
import { clerkConfigured } from './AccountsProvider';

interface Props {
  onCreate: (name?: string, password?: string) => Promise<string>;
}

type RoomSummary = api.MyRoom;

export default function HomePage({ onCreate }: Props) {
  const navigate = useNavigate();
  const [roomName, setRoomName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingError, setCreatingError] = useState('');

  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState('');
  const [joining, setJoining] = useState(false);

  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Past rooms are a nicety, never a precondition: if this fails (guest, no
  // accounts, offline) the create form still works untouched.
  useEffect(() => {
    let alive = true;
    api
      .listMyRooms()
      .then((r) => {
        if (alive) setRooms(r);
      })
      .catch(() => {
        if (alive) setRooms([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    setCreatingError('');
    try {
      const id = await onCreate(roomName.trim() || undefined, password.trim() || undefined);
      navigate(`/meeting/${id}`);
    } catch (e) {
      setCreatingError(e instanceof Error ? e.message : 'Could not create the room.');
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    const raw = joinCode.trim();
    if (!raw || joining) return;
    setJoining(true);
    setJoinError('');
    // Accept a pasted link as readily as a bare id — people share links.
    const match = raw.match(/join\/([0-9a-f-]{36})/i);
    const roomId = match ? match[1] : raw;
    try {
      await api.getRoom(roomId);
      navigate(`/join/${roomId}`);
    } catch {
      setJoinError('No room found with that link or code.');
      setJoining(false);
    }
  };

  const copyLink = async (roomId: string) => {
    await navigator.clipboard.writeText(`${window.location.origin}/#/join/${roomId}`);
    setCopiedId(roomId);
    setTimeout(() => setCopiedId(null), 1800);
  };

  return (
    <div className="min-h-screen bg-bg-base flex">
      {/* ---- Left rail: navigation first, marketing never ---- */}
      <aside className="hidden md:flex w-60 flex-col border-r border-border bg-bg-surface/40 px-3 py-5 gap-1">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2.5 px-3 py-2 mb-4 cursor-pointer"
        >
          <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-primary/20">
            <FiVideo className="w-5 h-5 text-primary" />
          </span>
          <span className="font-heading font-bold text-foreground text-[15px]">MeetPlay</span>
        </button>

        <RailItem icon={<FiVideo />} label="Rooms" active onClick={() => navigate('/')} />
        <RailItem icon={<FiClock />} label="Recent" onClick={() => {}} muted />
        <RailItem icon={<FiLogIn />} label="Join a room" onClick={() => document.getElementById('join-code')?.focus()} />

        {/* Secondary pages live here, small and out of the way. */}
        <div className="mt-auto pt-4 border-t border-border space-y-1">
          <RailItem icon={<FiArrowRight />} label="How it works" onClick={() => navigate('/about')} muted small />
          <RailItem icon={<FiArrowRight />} label="Pricing" onClick={() => navigate('/pricing')} muted small />
        </div>
      </aside>

      {/* ---- Main canvas ---- */}
      <main className="flex-1 min-w-0">
        <header className="flex items-center justify-between px-5 md:px-8 h-16 border-b border-border">
          <div className="flex items-center gap-2.5 md:hidden">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/20">
              <FiVideo className="w-4 h-4 text-primary" />
            </span>
            <span className="font-heading font-bold text-foreground text-sm">MeetPlay</span>
          </div>
          <div className="hidden md:block" />
          <div className="flex items-center gap-2">
            {/* Sign in / Sign up live here, top right. Plain buttons on the
                landing page rather than a wall: the room form still works
                without an account, so the buttons are an offer, not a gate.

                AccountMenu already renders SignedOutButton itself when nobody
                is signed in, so mounting only AccountMenu gives exactly one
                pair of buttons for guests and the profile menu once signed in. */}
            {clerkConfigured && <AccountMenu />}
            <ThemeToggle />
          </div>
        </header>

        <div className="max-w-2xl mx-auto px-5 md:px-8 py-10 md:py-14">
          <h1 className="font-heading text-2xl md:text-[28px] font-bold text-foreground">
            Start a meeting
          </h1>
          <p className="text-sm text-muted mt-1.5">
            Name it, or don't. You'll be in the room in one click.
          </p>

          {/* ---- Create: the single primary action ---- */}
          <div className="mt-7 rounded-2xl border border-border bg-bg-surface p-5 md:p-6">
            <label className="block text-xs font-medium text-muted mb-2 uppercase tracking-wide">
              Room name <span className="normal-case tracking-normal opacity-60">(optional)</span>
            </label>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                placeholder="Monday standup"
                maxLength={80}
                className="flex-1 px-3.5 py-3 bg-bg-base border border-border rounded-xl text-foreground placeholder:text-muted/50 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-colors text-sm"
              />
              <button
                onClick={handleCreate}
                disabled={creating}
                className="shrink-0 inline-flex items-center justify-center gap-2 px-5 py-3 bg-primary hover:bg-primary-hover text-on-primary font-medium rounded-xl transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer text-sm"
              >
                <FiPlus className="w-4 h-4" />
                {creating ? 'Creating…' : 'Create room'}
              </button>
            </div>

            {creatingError && (
              <p className="mt-3 text-xs text-destructive">{creatingError}</p>
            )}

            {/* Password is real but hidden: most rooms don't need one, and a
                second visible field makes creating feel like paperwork. */}
            <button
              onClick={() => setShowPassword((v) => !v)}
              className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground transition-colors cursor-pointer"
            >
              <FiLock className="w-3.5 h-3.5" />
              {showPassword ? 'Remove password' : 'Add a password'}
              <FiChevronDown
                className={`w-3.5 h-3.5 transition-transform ${showPassword ? 'rotate-180' : ''}`}
              />
            </button>
            {showPassword && (
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Room password"
                maxLength={60}
                className="mt-2.5 w-full px-3.5 py-2.5 bg-bg-base border border-border rounded-xl text-foreground placeholder:text-muted/50 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-colors text-sm"
              />
            )}
          </div>

          {/* ---- Join: the other half of the job, not a second tab ---- */}
          <div className="mt-8">
            <h2 className="font-heading text-sm font-semibold text-foreground mb-2.5">
              Or join one
            </h2>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                id="join-code"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                placeholder="Paste a room link or code"
                className="flex-1 px-3.5 py-2.5 bg-bg-surface border border-border rounded-xl text-foreground placeholder:text-muted/50 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-colors text-sm"
              />
              <button
                onClick={handleJoin}
                disabled={joining || !joinCode.trim()}
                className="shrink-0 px-4 py-2.5 border border-border bg-bg-surface hover:bg-bg-elevated text-foreground font-medium rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer text-sm"
              >
                {joining ? 'Looking…' : 'Join'}
              </button>
            </div>
            {joinError && <p className="mt-2 text-xs text-destructive">{joinError}</p>}
          </div>

          {/* ---- Rooms you've already got ---- */}
          {rooms && rooms.length > 0 && (
            <div className="mt-10">
              <h2 className="font-heading text-sm font-semibold text-foreground mb-2.5">
                Your rooms
              </h2>
              <ul className="divide-y divide-border rounded-xl border border-border bg-bg-surface overflow-hidden">
                {rooms.slice(0, 6).map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 shrink-0">
                      <FiVideo className="w-3.5 h-3.5 text-primary" />
                    </span>
                    <button
                      onClick={() => navigate(`/join/${r.id}`)}
                      className="flex-1 min-w-0 text-left cursor-pointer"
                    >
                      <span className="block text-sm text-foreground truncate">
                        {r.name?.trim() || 'Untitled room'}
                      </span>
                      <span className="block text-[11px] text-muted truncate">
                        {r.state === 'active' ? 'Active room' : 'Ended'}
                        {r.hasPassword ? ' · password' : ''}
                      </span>
                    </button>
                    <button
                      onClick={() => copyLink(r.id)}
                      className="p-2 rounded-lg text-muted hover:text-foreground hover:bg-bg-elevated transition-colors cursor-pointer shrink-0"
                      aria-label="Copy room link"
                    >
                      {copiedId === r.id ? (
                        <FiCheck className="w-4 h-4 text-success" />
                      ) : (
                        <FiCopy className="w-4 h-4" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-10 text-[11px] text-muted/60 leading-relaxed">
            Rooms close themselves when everyone leaves.
          </p>
        </div>
      </main>
    </div>
  );
}

function RailItem({  icon,
  label,
  active,
  muted,
  small,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  muted?: boolean;
  small?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'flex items-center gap-2.5 w-full rounded-lg transition-colors cursor-pointer',
        small ? 'px-3 py-1.5 text-xs' : 'px-3 py-2 text-sm',
        active
          ? 'bg-primary/15 text-primary font-medium'
          : muted
            ? 'text-muted hover:bg-bg-elevated hover:text-foreground'
            : 'text-foreground hover:bg-bg-elevated',
      ].join(' ')}
    >
      <span className={small ? '[&>svg]:w-3.5 [&>svg]:h-3.5' : '[&>svg]:w-4 [&>svg]:h-4'}>
        {icon}
      </span>
      {label}
    </button>
  );
}

