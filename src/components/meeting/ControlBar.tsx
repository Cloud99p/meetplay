import { useState, useContext } from 'react';
import {
  FiMic, FiMicOff, FiVideo, FiVideoOff,
  FiMonitor, FiMessageSquare, FiUsers,
  FiLogOut, FiSmile, FiCircle,
} from 'react-icons/fi';
import { LuHand } from 'react-icons/lu';
import { RoomContext } from '@livekit/components-react';
import { Track } from 'livekit-client';
import TranscriptToggle from './TranscriptToggle';
import ThemeToggle from '../ThemeToggle';

const QUICK_EMOJIS = ['👍', '😂', '❤️', '🎉', '🤔', '👏', '🙌', '🔥'];

interface Props {
  isHost: boolean;
  transcriptionEnabled: boolean;
  recording: boolean;
  /**
   * False when the server has no storage destination for egress (no S3_*
   * env vars): the button stays visible but disabled with an explanatory
   * tooltip, instead of silently failing on click.
   */
  recordingAvailable?: boolean;
  /** Why recording is unavailable — shown to the host instead of a generic message. */
  recordingReason?: string | null;
  /** Authoritative mic state from MeetingRoom — works even when LiveKit is
   *  disconnected (text mode) or the mic track hasn't been published yet.
   *  Previously the icon derived from micPub?.isMuted, which is `undefined`
   *  without a LiveKit connection, so the button always looked ON and clicking
   *  did nothing. */
  micMuted?: boolean;
  onToggleRecording?: () => void;
  onToggleMic?: () => void;
  onToggleCam?: () => void;
  onToggleScreenShare?: () => void;
  onToggleChat?: () => void;
  onToggleParticipants?: () => void;
  onToggleTranscription?: (enabled?: boolean) => void;
  onRaiseHand?: () => void;
  /** True while MY hand is up, so the button can show it is latched. */
  handRaised?: boolean;
  onSendEmoji?: (emoji: string) => void;
  onLeave?: () => void;
  showChat: boolean;
  showParticipants: boolean;
}

export default function ControlBar({
  isHost,
  transcriptionEnabled,
  recording,
  recordingAvailable = true,
  recordingReason = null,
  micMuted,
  onToggleRecording,
  onToggleMic,
  onToggleCam,
  onToggleScreenShare,
  onToggleChat,
  onToggleParticipants,
  onToggleTranscription,
  onRaiseHand,
  handRaised = false,
  onSendEmoji,
  onLeave,
  showChat,
  showParticipants,
}: Props) {
  // Read the LiveKit room context directly instead of useLocalParticipant:
  // the hook THROWS "No room provided" when the context is undefined (text
  // mode / connecting), which would crash the whole meeting.
  const liveKitRoom = useContext(RoomContext);
  const localParticipant = liveKitRoom?.localParticipant ?? null;
  const micPub = localParticipant?.getTrackPublication(Track.Source.Microphone);
  const camPub = localParticipant?.getTrackPublication(Track.Source.Camera);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  // Screen share needs getDisplayMedia (desktop only)
  const [isTouchDevice] = useState(
    () => typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)
  );

  const isMicOn = micMuted !== undefined ? !micMuted : !micPub?.isMuted;
  const isCamOn = !camPub?.isMuted;

  const btnClass =
    'flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-bg-elevated hover:bg-border text-foreground transition-colors duration-150 cursor-pointer active:scale-95';

  return (
    <div className="flex flex-wrap items-center justify-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 bg-bg-surface border-t border-border">
      {/* Mic */}
      <button onClick={onToggleMic} className={`${btnClass} ${!isMicOn ? 'bg-destructive/20 text-destructive' : ''}`} title={isMicOn ? 'Mute' : 'Unmute'}>
        {isMicOn ? <FiMic className="w-4 h-4" /> : <FiMicOff className="w-4 h-4" />}
      </button>

      {/* Camera */}
      <button onClick={onToggleCam} className={`${btnClass} ${!isCamOn ? 'bg-destructive/20 text-destructive' : ''}`} title={isCamOn ? 'Camera off' : 'Camera on'}>
        {isCamOn ? <FiVideo className="w-4 h-4" /> : <FiVideoOff className="w-4 h-4" />}
      </button>

      {/* Screen share (desktop only — hidden on touch devices) */}
      {!isTouchDevice && (
        <button onClick={onToggleScreenShare} className={btnClass} title="Share screen">
          <FiMonitor className="w-4 h-4" />
        </button>
      )}

      {/* Raise hand */}
      <button
          onClick={onRaiseHand}
          className={`${btnClass} ${handRaised ? 'bg-secondary/20 text-secondary' : ''}`}
          title={handRaised ? 'Lower hand' : 'Raise hand'}
        >
          <LuHand className="w-4 h-4" />
      </button>

      {/* Emoji quick reaction */}
      <div className="relative">
        <button
          onClick={() => setShowEmojiPicker((v) => !v)}
          className={`${btnClass} ${showEmojiPicker ? 'bg-primary/20 text-primary' : ''}`}
          title="React"
        >
          <FiSmile className="w-4 h-4" />
        </button>
        {showEmojiPicker && (
          <div className="absolute bottom-12 left-1/2 -translate-x-1/2 flex gap-1 p-2 bg-bg-elevated border border-border rounded-lg shadow-lg z-50">
            {QUICK_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => {
                  onSendEmoji?.(emoji);
                  setShowEmojiPicker(false);
                }}
                className="w-9 h-9 flex items-center justify-center rounded-md hover:bg-border transition-colors cursor-pointer text-xl"
                title={emoji}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Host: record the call.
          Egress needs an S3-compatible destination (see
          server/src/livekit/recording.ts) — when the server has none the
          button is disabled with the reason in the tooltip rather than
          failing on click. The REC state renders for every participant so
          nobody is recorded unknowingly. */}
      {isHost && (
        <button
          onClick={onToggleRecording}
          disabled={!recordingAvailable && !recording}
          className={`${btnClass} ${
            recording
              ? 'bg-destructive/20 text-destructive'
              : ''
          } ${!recordingAvailable && !recording ? 'opacity-40 cursor-not-allowed' : ''}`}
          title={
            recording
              ? 'Stop recording'
              : recordingAvailable
                ? 'Record call'
                : recordingReason ??
                  'Recording unavailable — server has no storage destination configured'
          }
        >
          {/* Filled dot while live, ring otherwise */}
          <FiCircle className={`w-4 h-4 ${recording ? 'fill-current animate-pulse' : ''}`} />
        </button>
      )}

      <div className="w-px h-6 bg-border mx-1" />

      {/* Host: transcription toggle */}
      {isHost && (
        <TranscriptToggle
          isHost
          enabled={transcriptionEnabled}
          onToggle={async (enabled) => onToggleTranscription?.(enabled)}
        />
      )}

      <div className="w-px h-6 bg-border mx-1" />

      {/* Chat */}
      <button onClick={onToggleChat} className={`${btnClass} ${showChat ? 'bg-primary/20 text-primary' : ''}`} title="Chat">
        <FiMessageSquare className="w-4 h-4" />
      </button>

      {/* Participants */}
      <button onClick={onToggleParticipants} className={`${btnClass} ${showParticipants ? 'bg-primary/20 text-primary' : ''}`} title="Participants">
        <FiUsers className="w-4 h-4" />
      </button>

      <div className="w-px h-6 bg-border mx-1" />

      {/* Theme — a per-person display preference, so unlike the host-only
          controls above it is deliberately NOT host-gated: everyone in the
          call picks their own, and it is never sent to the server. */}
      <ThemeToggle />

      <div className="flex-1" />

      {/* Leave / End */}
      <button
        onClick={onLeave}
        className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors duration-150 cursor-pointer active:scale-95 text-sm font-medium"
      >
        <FiLogOut className="w-4 h-4" />
        {isHost ? 'End' : 'Leave'}
      </button>
    </div>
  );
}