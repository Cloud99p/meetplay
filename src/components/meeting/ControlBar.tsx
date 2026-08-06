import { useState } from 'react';
import {
  FiMic, FiMicOff, FiVideo, FiVideoOff,
  FiMonitor, FiMessageSquare, FiUsers,
  FiLogOut, FiSmile,
} from 'react-icons/fi';
import { LuHand } from 'react-icons/lu';
import { useLocalParticipant } from '@livekit/components-react';
import { Track } from 'livekit-client';
import TranscriptToggle from './TranscriptToggle';

const QUICK_EMOJIS = ['👍', '😂', '❤️', '🎉', '🤔', '👏', '🙌', '🔥'];

interface Props {
  isHost: boolean;
  transcriptionEnabled: boolean;
  onToggleMic?: () => void;
  onToggleCam?: () => void;
  onToggleScreenShare?: () => void;
  onToggleChat?: () => void;
  onToggleParticipants?: () => void;
  onToggleTranscription?: (enabled?: boolean) => void;
  onRaiseHand?: () => void;
  onSendEmoji?: (emoji: string) => void;
  onLeave?: () => void;
  showChat: boolean;
  showParticipants: boolean;
}

export default function ControlBar({
  isHost,
  transcriptionEnabled,
  onToggleMic,
  onToggleCam,
  onToggleScreenShare,
  onToggleChat,
  onToggleParticipants,
  onToggleTranscription,
  onRaiseHand,
  onSendEmoji,
  onLeave,
  showChat,
  showParticipants,
}: Props) {
  const { localParticipant } = useLocalParticipant();
  const micPub = localParticipant?.getTrackPublication(Track.Source.Microphone);
  const camPub = localParticipant?.getTrackPublication(Track.Source.Camera);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  // Screen share needs getDisplayMedia (desktop only)
  const [isTouchDevice] = useState(
    () => typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)
  );

  const isMicOn = !micPub?.isMuted;
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
      <button onClick={onRaiseHand} className={btnClass} title="Raise hand">
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