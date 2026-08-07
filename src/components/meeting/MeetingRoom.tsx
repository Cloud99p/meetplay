import { useState, useCallback, useEffect } from 'react';
import type { MeetingState, MeetingActions } from '../../hooks/useMeeting';
import { useStt } from '../../hooks/useStt';
import { FiAlertTriangle, FiCircle, FiLink, FiUsers } from 'react-icons/fi';
import VideoGrid from './VideoGrid';
import SpeakerView from './SpeakerView';
import ControlBar from './ControlBar';
import CaptionsOverlay from './Captions';
import ParticipantList from './ParticipantList';
import ConsentBanner from './ConsentBanner';
import ChatPanel from '../chat/ChatPanel';
import GamesPanel from '../games/GamesPanel';
import { useLocalParticipant, RoomAudioRenderer } from '@livekit/components-react';
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
  const { localParticipant } = useLocalParticipant();

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

  // Show consent banner when transcription is first enabled
  useEffect(() => {
    if (state.transcriptionEnabled && !consentShown) {
      setConsentShown(true);
    }
  }, [state.transcriptionEnabled, consentShown]);

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
      {/* Consent Banner */}
      <ConsentBanner visible={consentShown} onDismiss={() => setConsentShown(false)} />

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
          {/* Remote audio playback — attaches every participant's mic
              track to an <audio> element. Without this, remote audio is
              received by the SDK but never played: total silence. */}
          <RoomAudioRenderer />
          {viewMode === 'grid' ? (
            <VideoGrid onSpeakerClick={(id) => { setActiveSpeakerId(id); setViewMode('speaker'); }} />
          ) : (
            <SpeakerView activeSpeakerId={activeSpeakerId} />
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

          {/* Side panel buttons on video */}
          <div className="absolute top-4 right-4 flex gap-1.5 sm:gap-2">
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
                  bingo={state.bingo}
                  stats={state.stats}
                  onMarketBet={(guess) => actions.placeMarketBet(guess)}
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