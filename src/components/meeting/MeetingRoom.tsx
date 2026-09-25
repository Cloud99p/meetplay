import { useState, useCallback, useEffect, useRef, useContext } from 'react';
import type { MeetingState, MeetingActions } from '../../hooks/useMeeting';
import { useStt } from '../../hooks/useStt';
import { FiAlertTriangle, FiCircle, FiLink, FiMicOff, FiUsers } from 'react-icons/fi';
import VideoGrid from './VideoGrid';
import VideoDebug from './VideoDebug';
import SpeakerView from './SpeakerView';
import ControlBar from './ControlBar';
import CaptionsOverlay, { TRANSCRIPT_MODES, resolveTranscriptMode, type TranscriptMode } from './Captions';
import HandRaiseToasts from './HandRaiseToasts';
import { diffHands, type HandAnnouncement } from '../../lib/meeting/handEvents';
import ParticipantList from './ParticipantList';
import ConsentBanner from './ConsentBanner';
import ChatPanel from '../chat/ChatPanel';
import GamesPanel from '../games/GamesPanel';
import { RoomContext, RoomAudioRenderer } from '@livekit/components-react';
import { RoomEvent, type Participant as LKParticipant } from 'livekit-client';
import type { GameRound } from '../../types/games';

/** Personal transcript-panel preference. Local, never sent to the server. */
const TRANSCRIPT_MODE_KEY = 'meetplay.transcript-mode';

interface Props {
  state: MeetingState;
  actions: MeetingActions;
  onLeave: () => void;
}

export default function MeetingRoom({ state, actions, onLeave }: Props) {
  const [viewMode, setViewMode] = useState<'grid' | 'speaker'>('grid');
  const [showChat, setShowChat] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [showGames, setShowGames] = useState(false);
  const [consentShown, setConsentShown] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [sttError, setSttError] = useState<string | null>(null);
  const [sttLevel, setSttLevel] = useState(0);
  const [screenShareError, setScreenShareError] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
  // Speaker view FOLLOWS whoever is talking by default. Clicking a tile pins that
  // person and stops the follow; switching back into the view resumes it. Before
  // this the view showed whoever happened to be first in the participant list, so
  // it never tracked the person actually speaking.
  const [followSpeaker, setFollowSpeaker] = useState(true);
  const [recordingNoticeDismissed, setRecordingNoticeDismissed] = useState(false);
  const [captionsNudgeDismissed, setCaptionsNudgeDismissed] = useState(false);
  // Caption display mode. A personal preference, so it lives here in
  // localStorage rather than in room state — the server never needs to agree
  // with the client about it, so there is no wire flag that can drift.
  // Defaults to hidden: a call looks exactly as it did before unless asked.
  // resolveTranscriptMode also maps the retired `transparent` value onto
  // `visible`, so a preference saved by that build still shows captions.
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>(() => {
    if (typeof window === 'undefined') return 'hidden';
    try {
      return resolveTranscriptMode(window.localStorage.getItem(TRANSCRIPT_MODE_KEY));
    } catch {
      /* storage disabled (private mode) — fall through to the default */
      return 'hidden';
    }
  });
  const changeTranscriptMode = useCallback((mode: TranscriptMode) => {
    setTranscriptMode(mode);
    try {
      window.localStorage.setItem(TRANSCRIPT_MODE_KEY, mode);
    } catch {
      /* ignore — the mode still applies for this session */
    }
  }, []);

  // Track the active speaker from LiveKit itself (server-side voice activity, not
  // a guess from audio levels). LiveKit includes the local participant when you
  // are the one talking.
  useEffect(() => {
    const room = state.liveKitRoom;
    if (!room) return;
    const apply = (speakers: LKParticipant[]) => {
      if (!followSpeaker) return;
      const next = speakers[0]?.identity;
      if (next) setActiveSpeakerId(next);
    };
    apply(room.activeSpeakers ?? []);
    room.on(RoomEvent.ActiveSpeakersChanged, apply);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, apply);
    };
  }, [state.liveKitRoom, followSpeaker]);
  // Whose hand is up right now — drives the button's pressed state, the participant
  // list badge and the tile badge.
  const myHandRaised =
    state.participants.find((p) => p.id === state.participantId)?.handRaised ?? false;

  // --- Raising a hand should be LOUD ---------------------------------------
  // The state logic here was already correct (the server tracks hands, the
  // client derives them, verify:hand round-trips 8/8), yet a hand going up was
  // invisible in practice: a tiny glyph on a tile, and a button that only
  // latched once the server echo came back. So instead of more plumbing, make
  // it visible:
  //   1. clicking latches immediately (optimistic) and announces locally, so the
  //      person who clicked never waits on a round trip to see it worked;
  //   2. everyone else's raise is announced BY NAME with an animation.
  const [handAnnouncements, setHandAnnouncements] = useState<HandAnnouncement[]>([]);
  const prevParticipantsRef = useRef(state.participants);
  // Non-null while a click is not yet confirmed by the server.
  const [pendingHand, setPendingHand] = useState<boolean | null>(null);
  const effectiveHand = pendingHand ?? myHandRaised;

  // Others' raises come from the participant diff — the derived, server-seeded
  // truth. Your own is announced at click time, so it is filtered out here to
  // avoid announcing it twice.
  useEffect(() => {
    const prev = prevParticipantsRef.current;
    prevParticipantsRef.current = state.participants;
    if (prev === state.participants) return;
    const changes = diffHands(prev, state.participants, state.participantId).filter((a) => !a.isSelf);
    if (changes.length > 0) setHandAnnouncements((cur) => [...cur, ...changes].slice(-4));
  }, [state.participants, state.participantId]);

  // Clear the optimistic value once the server agrees, or give up after a few
  // seconds so a failed send cannot leave the button stuck latched.
  useEffect(() => {
    if (pendingHand === null) return;
    if (myHandRaised === pendingHand) {
      setPendingHand(null);
      return;
    }
    const timer = setTimeout(() => setPendingHand(null), 5000);
    return () => clearTimeout(timer);
  }, [pendingHand, myHandRaised]);

  const dismissHandAnnouncement = useCallback((id: string) => {
    setHandAnnouncements((cur) => cur.filter((a) => a.id !== id));
  }, []);

  const toggleHand = useCallback(() => {
    const next = !effectiveHand;
    setPendingHand(next);
    setHandAnnouncements((cur) =>
      [
        ...cur,
        {
          id: `self-${next ? 'raised' : 'lowered'}-${Date.now()}`,
          participantId: state.participantId ?? 'self',
          name: 'You',
          action: next ? ('raised' as const) : ('lowered' as const),
          isSelf: true,
          at: Date.now(),
        },
      ].slice(-4)
    );
    actions.toggleHand(next);
  }, [effectiveHand, actions, state.participantId]);
  // LiveKit room context — null when the media server is unreachable or while
  // connecting. Reading the context directly (instead of useLocalParticipant)
  // is deliberate: the hook THROWS "No room provided" when the context is
  // undefined, which would crash the whole meeting (chat/games/captions are
  // supposed to keep working in text mode).
  const liveKitRoom = useContext(RoomContext);
  const localParticipant = liveKitRoom?.localParticipant ?? null;

  // Re-show recording result/error notices when a new one arrives
  useEffect(() => {
    setRecordingNoticeDismissed(false);
  }, [state.recordingResult, state.recordingError]);

  // Mock STT lifecycle: starts when transcription is on + room connected,
  // wires utterances to the server, uses the local participant id as speaker.
  useStt({
    enabled: state.transcriptionEnabled,
    connected: state.connected,
    localParticipantId: state.participantId ?? undefined,
    muted: micMuted,
    onError: setSttError,
    onLevel: setSttLevel,
    sendCaption: actions.sendCaption,
  });

  // Show consent banner when transcription is first enabled. Dismissal is
  // permanent for this meeting (ref, not state — otherwise the effect re-fires
  // on every consentShown change and immediately re-shows the banner).
  const consentDismissedRef = useRef(false);
  useEffect(() => {
    if (state.transcriptionEnabled && !consentDismissedRef.current && !consentShown) {
      setConsentShown(true);
    }
  }, [state.transcriptionEnabled]);
  const handleDismissConsent = useCallback(() => {
    consentDismissedRef.current = true;
    setConsentShown(false);
  }, []);

  const handleToggleMic = useCallback(async () => {
    // Mute state is authoritative in React state so the button ALWAYS works,
    // even when LiveKit is disconnected (text mode) or the mic track hasn't
    // been published yet. LiveKit is synced when available; the STT adapter
    // (which captures its own getUserMedia stream) is muted via useStt so the
    // app actually stops listening.
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    setMicMuted(next);
    if (localParticipant) {
      try {
        await localParticipant.setMicrophoneEnabled(!next);
      } catch (e) {
        console.error('[meeting] mic toggle error:', e);
      }
    }
  }, [localParticipant]);

  // Keep the ref in sync so the callback above always reads the latest state
  // (it's excluded from deps deliberately — LiveKit identity changes would
  // otherwise re-create the handler and reset the toggle mid-press).
  const micMutedRef = useRef(micMuted);
  micMutedRef.current = micMuted;

  const handleToggleCam = useCallback(async () => {
    if (!localParticipant) return;
    try {
      await localParticipant.setCameraEnabled(!localParticipant.isCameraEnabled);
    } catch (e) {
      console.error('[meeting] camera toggle error:', e);
    }
  }, [localParticipant]);

  const handleToggleScreenShare = useCallback(async () => {
    if (!localParticipant) return;
    try {
      await localParticipant.setScreenShareEnabled(!localParticipant.isScreenShareEnabled);
      setScreenShareError(null);
    } catch (e: any) {
      const msg = e?.message ?? '';
      console.error('[meeting] screen share error:', e);
      // Permissions-Policy blocks getDisplayMedia (common in iframe previews)
      if (msg.includes('display-capture') || msg.includes('NotAllowedError')) {
        setScreenShareError(
          'Screen share is blocked in this preview (permissions policy). ' +
          'It works when the app is deployed to its own origin, e.g. Railway.'
        );
      } else {
        setScreenShareError(msg || 'Screen share failed.');
      }
    }
  }, [localParticipant]);

  // Host: "End" ends the meeting for EVERYONE (server hard-ends the room and
  // deletes the LiveKit room). Guest: "Leave" just exits this client.
  const handleEndOrLeave = useCallback(() => {
    if (state.isHost) {
      actions.endMeeting();
    } else {
      onLeave();
    }
  }, [state.isHost, actions, onLeave]);

  const sidePanelOpen = showChat || showParticipants || showGames;

  return (
    <div className="h-screen flex flex-col bg-bg-base">
      {/* Captions & games OFF nudge — host only, dismissible. The entire
          engagement layer (word guesses, bingo, quizzes) is starved without
          transcription, so make it loud. */}
      {state.isHost && !state.transcriptionEnabled && !captionsNudgeDismissed && (
        <div
          role="status"
          className="flex items-center gap-3 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/30 text-sm text-foreground"
        >
          <FiMicOff className="w-4 h-4 text-amber-500 flex-shrink-0 animate-pulse" />
          <p className="flex-1 min-w-0">
            <span className="font-semibold">Captions &amp; games are off.</span>
            <span className="text-muted"> Enable transcription to unlock word guesses, bingo and the recap quiz.</span>
          </p>
          <button
            onClick={() => actions.toggleTranscription(true)}
            className="text-xs font-semibold px-3 py-1.5 rounded-md bg-amber-500/20 text-amber-500 hover:bg-amber-500/30 transition-colors cursor-pointer"
          >
            Enable now
          </button>
          <button
            onClick={() => setCaptionsNudgeDismissed(true)}
            className="text-xs font-medium px-2 py-1.5 rounded-md text-muted hover:text-foreground transition-colors cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Consent Banner */}
      <ConsentBanner visible={consentShown} onDismiss={handleDismissConsent} />

      {/* STT/mic error banner — surfaced when the adapter can't capture
          (e.g. mic permission denied), so users see why captions are silent. */}
      {/* Rate-limit notice — the server dropped frames because we flooded it */}
      {state.rateLimitNotice && (
        <div
          role="status"
          className="flex items-center gap-3 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/30 text-sm text-foreground"
        >
          <FiAlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <p className="flex-1 min-w-0">{state.rateLimitNotice}</p>
        </div>
      )}
      {sttError && (
        <div
          role="alert"
          className="flex items-center gap-3 px-4 py-2.5 bg-destructive/10 border-b border-destructive/30 text-sm text-foreground"
        >
          <FiMicOff className="w-4 h-4 text-destructive flex-shrink-0" />
          <p className="flex-1 min-w-0">{sttError}</p>
          <button
            onClick={() => setSttError(null)}
            className="text-xs font-medium px-2 py-1.5 rounded-md text-muted hover:text-foreground transition-colors cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Screen share error banner (permissions policy in iframe previews) */}
      {screenShareError && (
        <div
          role="alert"
          className="flex items-center gap-3 px-4 py-2.5 bg-destructive/10 border-b border-destructive/30 text-sm text-foreground"
        >
          <FiAlertTriangle className="w-4 h-4 text-destructive flex-shrink-0" />
          <p className="flex-1 min-w-0">{screenShareError}</p>
          <button
            onClick={() => setScreenShareError(null)}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-bg-elevated hover:bg-border transition-colors cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* LiveKit reconnecting banner — network blip, auto-retrying in background */}
      {state.liveKitReconnecting && !state.liveKitConnected && (
        <div
          role="status"
          className="flex items-center gap-3 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/30 text-sm text-foreground"
        >
          <FiAlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 animate-pulse" />
          <p className="flex-1 min-w-0">
            <span className="font-semibold">Video &amp; audio reconnecting…</span>
            <span className="text-muted"> — network blip detected, retrying automatically. Hang tight.</span>
          </p>
          <button
            onClick={onLeave}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-bg-elevated hover:bg-border transition-colors cursor-pointer"
          >
            Leave meeting
          </button>
        </div>
      )}

      {/* LiveKit unavailable banner — meeting still works in text mode */}
      {state.livekitError && !state.liveKitConnected && !state.liveKitReconnecting && (
        <div
          role="alert"
          className="flex items-center gap-3 px-4 py-2.5 bg-destructive/10 border-b border-destructive/30 text-sm text-foreground"
        >
          <FiAlertTriangle className="w-4 h-4 text-destructive flex-shrink-0" />
          <p className="flex-1 min-w-0">
            <span className="font-semibold">Video &amp; audio are unavailable</span>
            <span className="text-muted"> — the media server isn't reachable. Chat, games and captions still work.</span>
          </p>
          <button
            onClick={onLeave}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-bg-elevated hover:bg-border transition-colors cursor-pointer"
          >
            Leave meeting
          </button>
        </div>
      )}

      {/* Recording result / error notices */}
      {state.recordingResult && !recordingNoticeDismissed && (
        <div
          role="status"
          className="flex items-center gap-3 px-4 py-2.5 bg-primary/10 border-b border-primary/30 text-sm text-foreground"
        >
          <FiCircle className="w-4 h-4 text-primary flex-shrink-0 fill-current" />
          <p className="flex-1 min-w-0">
            <span className="font-semibold">Recording saved</span>
            {state.recordingResult.downloadUrl ? (
              <>
                <span className="text-muted"> — </span>
                <a
                  href={state.recordingResult.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline text-primary hover:text-primary/80"
                >
                  Download recording
                </a>
              </>
            ) : (
              <span className="text-muted">
                {' '}— file finalized on the LiveKit server{state.recordingResult.filename ? ` (${state.recordingResult.filename})` : ''}. Ask the host for the download link.
              </span>
            )}
          </p>
          <button
            onClick={() => setRecordingNoticeDismissed(true)}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-bg-elevated hover:bg-border transition-colors cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}
      {state.recordingError && !recordingNoticeDismissed && (
        <div
          role="alert"
          className="flex items-center gap-3 px-4 py-2.5 bg-destructive/10 border-b border-destructive/30 text-sm text-foreground"
        >
          <FiAlertTriangle className="w-4 h-4 text-destructive flex-shrink-0" />
          <p className="flex-1 min-w-0">
            <span className="font-semibold">Recording failed</span>
            <span className="text-muted"> — {state.recordingError}</span>
          </p>
          <button
            onClick={() => setRecordingNoticeDismissed(true)}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-bg-elevated hover:bg-border transition-colors cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Video area */}
        <div className="flex-1 relative min-w-0">
          {/* LiveKit media — only rendered when a room actually exists. The
              LiveKit hooks (useTracks, useRemoteParticipants) throw without a
              RoomContext, so in text mode (no media server) we render a
              placeholder instead of crashing the whole meeting. */}
          {liveKitRoom ? (
            <>
              {/* Remote audio playback — attaches every participant's mic
                  track to an <audio> element. Without this, remote audio is
                  received by the SDK but never played: total silence. */}
              <RoomAudioRenderer />
              {viewMode === 'grid' ? (
                <VideoGrid
          onSpeakerClick={(id) => {
            // A deliberate click wins over the automatic follow.
            setFollowSpeaker(false);
            setActiveSpeakerId(id);
            setViewMode('speaker');
          }}
          raisedIds={state.participants.filter((p) => p.handRaised).map((p) => p.id)}
          tileShape={state.tileShape}
        />
              ) : (
                <SpeakerView activeSpeakerId={activeSpeakerId} />
              )}
              {/* Quality readout. Renders only with ?debug=video in the URL
                  (hash-router form: #/room/<id>?debug=video), so a normal call
                  sees nothing. Read-only getStats() — it never changes publish
                  settings, so it cannot alter what it measures. */}
              <VideoDebug room={state.liveKitRoom} />
            </>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6">
              <FiAlertTriangle className="w-8 h-8 text-muted" />
              <p className="text-sm text-muted">
                Video &amp; audio are unavailable — the media server isn't reachable.
              </p>
              <p className="text-xs text-muted/70">Chat, games and captions still work.</p>
            </div>
          )}

          {/* On-screen captions. `transcriptMode` is a plain on/off for this
              text — it deliberately does not open a panel: the setting controls
              the captions in the middle of the screen, and a sidebar here would
              both cover the video and hide the very thing being toggled. */}
          <CaptionsOverlay
            captions={state.captions}
            mode={state.transcriptionEnabled ? transcriptMode : 'hidden'}
          />

          {/* "Ada raised their hand" — the visible half of raising a hand. */}
          <HandRaiseToasts
            announcements={handAnnouncements}
            onDismiss={dismissHandAnnouncement}
          />

          {/* Mic level meter — live proof audio is reaching the app. When the
              STT adapter's AudioContext is running and the mic is open, these
              bars dance as you speak. Flat bars + no captions = mic/capture
              problem; dancing bars + no captions = Deepgram/network problem. */}
          {state.transcriptionEnabled && !micMuted && (
            <div
              className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-end gap-[3px] h-5 px-2.5 py-1 rounded-full bg-caption-bg/90 backdrop-blur-sm z-30"
              title={sttLevel > 0.02 ? 'Microphone input detected' : 'Waiting for microphone input…'}
            >
              {[0.35, 0.6, 0.45, 0.75, 0.5].map((h, i) => {
                const active = sttLevel > 0.02 && sttLevel > h * 0.7;
                return (
                  <span
                    key={i}
                    className="w-[3px] rounded-full transition-all duration-100"
                    style={{
                      height: `${Math.max(4, h * 20 * (0.35 + Math.min(1, sttLevel * 3)))}px`,
                      backgroundColor: active ? '#22c55e' : 'rgba(148,163,184,0.5)',
                    }}
                  />
                );
              })}
            </div>
          )}

          {/* REC pill — visible to everyone while recording */}
          {state.recording && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 bg-destructive/90 text-white rounded-full text-xs font-semibold shadow-lg z-20">
              <FiCircle className="w-2.5 h-2.5 fill-white animate-pulse" />
              REC
            </div>
          )}

          {/* Top-left controls: view mode (everyone) + tile shape (host only) */}
          <div className="absolute top-4 left-4 flex flex-wrap items-center gap-2">
          {/* View mode toggle */}
          <button
            onClick={() => {
              const next = viewMode === 'grid' ? 'speaker' : 'grid';
              // Entering speaker view resumes following the speaker.
              if (next === 'speaker') setFollowSpeaker(true);
              setViewMode(next);
            }}
            title={
              viewMode === 'grid'
                ? 'Switch to speaker view (follows whoever is talking)'
                : 'Switch to grid view (everyone at once)'
            }
            className="px-2.5 sm:px-3 py-1.5 bg-caption-bg backdrop-blur-sm text-xs text-foreground rounded-md hover:bg-bg-elevated transition-colors cursor-pointer"
          >
            {viewMode === 'grid' ? 'Speaker view' : 'Grid view'}
          </button>

          {/* Host-only: tile shape for the whole room. Horizontal tiles fit more of
              everyone's background; "fill" is the old stretch-to-fit behaviour. */}
          {state.isHost && (
            <button
              onClick={() => {
                const order: Array<'16:9' | '4:3' | 'fill'> = ['16:9', '4:3', 'fill'];
                const current = order.indexOf(state.tileShape ?? '16:9');
                actions.setTileShape(order[(current + 0 + 1) % order.length]);
              }}
              className="px-2.5 sm:px-3 py-1.5 bg-caption-bg backdrop-blur-sm text-xs text-foreground rounded-md hover:bg-bg-elevated transition-colors cursor-pointer"
              title="Tile shape for everyone: horizontal, 4:3, or fill the grid"
            >
              Tiles: {state.tileShape === '4:3' ? '4:3' : state.tileShape === 'fill' ? 'Fill' : '16:9'}
            </button>
          )}
          </div>

          {/* Side panel buttons on video — on mobile (panel overlays) hide them
              while a panel is open since the panel has its own close X; keep
              them on sm+ where the panel is in-flow. */}
          <div className={`absolute top-4 right-4 sm:flex gap-1.5 sm:gap-2 ${sidePanelOpen ? 'hidden' : 'flex'} z-40`}>
            <button
              onClick={() => {
                const url = `${window.location.origin}/#/join/${state.room?.id}`;
                navigator.clipboard.writeText(url).then(() => {
                  setInviteCopied(true);
                  setTimeout(() => setInviteCopied(false), 2000);
                });
              }}
              className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-md text-xs transition-colors cursor-pointer bg-caption-bg backdrop-blur-sm text-foreground hover:bg-bg-elevated"
              title="Copy invite link"
            >
              <FiLink className="w-3.5 h-3.5" />
              {inviteCopied ? 'Copied!' : 'Invite'}
            </button>
            <button
              onClick={() => { setShowParticipants(false); setShowGames(false); setShowChat(!showChat); }}
              className={`px-2.5 sm:px-3 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${showChat ? 'bg-primary text-on-primary' : 'bg-caption-bg backdrop-blur-sm text-foreground hover:bg-bg-elevated'}`}
            >
              Chat
            </button>
            <button
              onClick={() => { setShowChat(false); setShowGames(false); setShowParticipants(!showParticipants); }}
              className={`px-2.5 sm:px-3 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${showParticipants ? 'bg-primary text-on-primary' : 'bg-caption-bg backdrop-blur-sm text-foreground hover:bg-bg-elevated'}`}
            >
              <FiUsers className="w-3.5 h-3.5 inline-block sm:hidden" />
              <span className="hidden sm:inline">People ({state.participants.length})</span>
              <span className="sm:hidden">({state.participants.length})</span>
            </button>
            <button
              onClick={() => { setShowChat(false); setShowParticipants(false); setShowGames(!showGames); }}
              className={`px-2.5 sm:px-3 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${showGames ? 'bg-primary text-on-primary' : 'bg-caption-bg backdrop-blur-sm text-foreground hover:bg-bg-elevated'}`}
            >
              Games
            </button>
            {/* Captions on/off for me. Hidden is the default, so nothing changes
                for anyone who never touches it. */}
            <button
              onClick={() => {
                const next =
                  TRANSCRIPT_MODES[(TRANSCRIPT_MODES.indexOf(transcriptMode) + 1) % TRANSCRIPT_MODES.length];
                changeTranscriptMode(next);
              }}
              className={`px-2.5 sm:px-3 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${transcriptMode !== 'hidden' ? 'bg-primary text-on-primary' : 'bg-caption-bg backdrop-blur-sm text-foreground hover:bg-bg-elevated'}`}
              title="Captions for me: Visible or Hidden"
            >
              Transcript: {transcriptMode === 'visible' ? 'Visible' : 'Hidden'}
            </button>
          </div>
        </div>

        {/* Right side panel */}
        {sidePanelOpen && (
          <div className="absolute inset-y-0 right-0 w-full sm:w-80 sm:relative sm:inset-auto border-l border-border bg-bg-surface flex flex-col z-30 shadow-2xl sm:shadow-none">
            {/* Mobile-visible close bar — on small screens the panel is a full-
                width overlay (z-30) that otherwise traps the user with no exit. */}
            <div className="sm:hidden flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="text-xs font-medium text-muted uppercase tracking-wider">
                {showGames ? 'Games' : showParticipants ? 'Participants' : 'Chat'}
              </span>
              <button
                onClick={() => { setShowGames(false); setShowParticipants(false); setShowChat(false); }}
                className="w-8 h-8 grid place-items-center rounded-md text-foreground hover:bg-bg-elevated transition-colors cursor-pointer"
                aria-label="Close panel"
                title="Close"
              >
                <span className="text-lg leading-none">✕</span>
              </button>
            </div>
            {showChat && (
              <ChatPanel
                messages={state.messages}
                onSend={actions.sendChat}
                participantId={state.participantId}
              />
            )}
            {showParticipants && (
              <ParticipantList
                participants={state.participants}
                isHost={state.isHost}
                currentId={state.participantId}
                onMute={actions.muteParticipant}
                onCamera={actions.setParticipantCamera}
                onRemove={actions.removeParticipant}
              />
            )}
            {showGames && (() => {
              // Convert activeRound to GameRound format expected by GamesPanel
              const gameRound: GameRound | null = state.activeRound
                ? {
                    id: state.activeRound.roundId,
                    gameType: state.activeRound.gameType as any,
                    state: state.activeRound.state as any,
                    roundData: state.activeRound.roundData,
                    timeLimit: state.activeRound.timeLimit,
                    startedAt: state.activeRound.startedAt,
                  }
                : null;
              return (
                <GamesPanel
                  activeRound={gameRound}
                  leaderboard={state.leaderboard}
                  onSubmit={(answer) => {
                    if (state.activeRound) {
                      actions.submitAnswer(state.activeRound.roundId, answer);
                    }
                  }}
                  onStartGame={(gameType) => actions.startGame(gameType)}
                  gameStartError={state.gameStartError}
                  participantId={state.participantId}
                  transcriptionEnabled={state.transcriptionEnabled}
                  quiet={state.gameQuiet}
                  market={state.market}
                  flash={state.flash}
                  userMarkets={state.userMarkets}
                  userMarketError={state.userMarketError}
                  bingo={state.bingo}
                  stats={state.stats}
                  onMarketBet={(guess) => actions.placeMarketBet(guess)}
                  onFlashBet={(guess) => {
                    if (state.flash && !state.flash.resolved) {
                      actions.placeFlashBet(state.flash.roundId, guess);
                    }
                  }}
                  onCreateUserMarket={(word, guess, durationSec) => actions.createUserMarket(word, guess, durationSec)}
                  onUserMarketBet={(roundId, guess) => actions.placeUserMarketBet(roundId, guess)}
                />
              );
            })()}
          </div>
        )}
      </div>

      {/* Control bar */}
      <ControlBar
        isHost={state.isHost}
        transcriptionEnabled={state.transcriptionEnabled}
        recording={state.recording}
        recordingAvailable={state.recordingAvailable}
            recordingReason={state.recordingReason}
        micMuted={micMuted}
        onToggleRecording={() =>
          state.recording ? actions.stopRecording() : actions.startRecording()
        }
        onToggleMic={handleToggleMic}
        onToggleCam={handleToggleCam}
        onToggleScreenShare={handleToggleScreenShare}
        onToggleChat={() => { setShowParticipants(false); setShowGames(false); setShowChat(!showChat); }}
        onToggleParticipants={() => { setShowChat(false); setShowGames(false); setShowParticipants(!showParticipants); }}
        onToggleTranscription={() => actions.toggleTranscription(!state.transcriptionEnabled)}
        onRaiseHand={toggleHand}
        handRaised={effectiveHand}
        onSendEmoji={actions.sendEmoji}
        onLeave={handleEndOrLeave}
        showChat={showChat}
        showParticipants={showParticipants}
      />
    </div>
  );
}