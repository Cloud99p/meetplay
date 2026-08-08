import { useState, useCallback, useEffect, useRef, useContext } from 'react';
import type { MeetingState, MeetingActions } from '../../hooks/useMeeting';
import { useStt } from '../../hooks/useStt';
import { FiAlertTriangle, FiCircle, FiLink, FiMicOff, FiUsers } from 'react-icons/fi';
import VideoGrid from './VideoGrid';
import SpeakerView from './SpeakerView';
import ControlBar from './ControlBar';
import CaptionsOverlay from './Captions';
import ParticipantList from './ParticipantList';
import ConsentBanner from './ConsentBanner';
import ChatPanel from '../chat/ChatPanel';
import GamesPanel from '../games/GamesPanel';
import { RoomContext, RoomAudioRenderer } from '@livekit/components-react';
import type { GameRound } from '../../types/games';

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
  const [screenShareError, setScreenShareError] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
  const [recordingNoticeDismissed, setRecordingNoticeDismissed] = useState(false);
  const [captionsNudgeDismissed, setCaptionsNudgeDismissed] = useState(false);
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
    if (!localParticipant) return;
    try {
      await localParticipant.setMicrophoneEnabled(!localParticipant.isMicrophoneEnabled);
    } catch (e) {
      console.error('[meeting] mic toggle error:', e);
    }
  }, [localParticipant]);

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
          engagement layer (word bets, bingo, quizzes) is starved without
          transcription, so make it loud. */}
      {state.isHost && !state.transcriptionEnabled && !captionsNudgeDismissed && (
        <div
          role="status"
          className="flex items-center gap-3 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/30 text-sm text-foreground"
        >
          <FiMicOff className="w-4 h-4 text-amber-500 flex-shrink-0 animate-pulse" />
          <p className="flex-1 min-w-0">
            <span className="font-semibold">Captions &amp; games are off.</span>
            <span className="text-muted"> Enable transcription to unlock word bets, bingo and the recap quiz.</span>
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
                <VideoGrid onSpeakerClick={(id) => { setActiveSpeakerId(id); setViewMode('speaker'); }} />
              ) : (
                <SpeakerView activeSpeakerId={activeSpeakerId} />
              )}
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

          {/* Captions overlay */}
          <CaptionsOverlay captions={state.captions} visible={state.transcriptionEnabled} />

          {/* REC pill — visible to everyone while recording */}
          {state.recording && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 bg-destructive/90 text-white rounded-full text-xs font-semibold shadow-lg z-20">
              <FiCircle className="w-2.5 h-2.5 fill-white animate-pulse" />
              REC
            </div>
          )}

          {/* View mode toggle */}
          <button
            onClick={() => setViewMode(viewMode === 'grid' ? 'speaker' : 'grid')}
            className="absolute top-4 left-4 px-2.5 sm:px-3 py-1.5 bg-caption-bg backdrop-blur-sm text-xs text-foreground rounded-md hover:bg-bg-elevated transition-colors cursor-pointer"
          >
            {viewMode === 'grid' ? 'Speaker' : 'Grid'}
          </button>

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
        onToggleRecording={() =>
          state.recording ? actions.stopRecording() : actions.startRecording()
        }
        onToggleMic={handleToggleMic}
        onToggleCam={handleToggleCam}
        onToggleScreenShare={handleToggleScreenShare}
        onToggleChat={() => { setShowParticipants(false); setShowGames(false); setShowChat(!showChat); }}
        onToggleParticipants={() => { setShowChat(false); setShowGames(false); setShowParticipants(!showParticipants); }}
        onToggleTranscription={() => actions.toggleTranscription(!state.transcriptionEnabled)}
        onRaiseHand={() => actions.toggleHand(true)}
        onSendEmoji={actions.sendEmoji}
        onLeave={handleEndOrLeave}
        showChat={showChat}
        showParticipants={showParticipants}
      />
    </div>
  );
}