import { FiVolume2, FiVolumeX, FiVideo, FiVideoOff, FiUserMinus, FiShield } from 'react-icons/fi';

interface Participant {
  id: string;
  name: string;
  isHost: boolean;
  isMuted: boolean;
  isCameraOff: boolean;
}

interface Props {
  participants: Participant[];
  isHost: boolean;
  currentId: string | null;
  onMute: (targetId: string, muted: boolean) => void;
  onCamera: (targetId: string, cameraOff: boolean) => void;
  onRemove: (targetId: string) => void;
}

export default function ParticipantList({ participants, isHost, currentId, onMute, onCamera, onRemove }: Props) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-medium text-foreground">Participants ({participants.length})</h3>
      </div>
      <div className="flex-1 overflow-y-auto">
        {participants.map((p) => {
          const isMe = p.id === currentId;
          return (
            <div key={p.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-elevated/50 transition-colors">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-heading font-semibold ${p.isHost ? 'bg-secondary/20 text-secondary' : 'bg-primary/20 text-primary'}`}>
                {p.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-foreground truncate">{p.name}</span>
                  {p.isHost && (
                    <FiShield className="w-3 h-3 text-secondary flex-shrink-0" title="Host" />
                  )}
                  {isMe && (
                    <span className="text-[10px] text-muted">(you)</span>
                  )}
                  {p.isMuted && (
                    <FiVolumeX className="w-3 h-3 text-muted flex-shrink-0" title="Muted by host" />
                  )}
                  {p.isCameraOff && (
                    <FiVideoOff className="w-3 h-3 text-muted flex-shrink-0" title="Camera off" />
                  )}
                </div>
              </div>
              {isHost && !isMe && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onMute(p.id, !p.isMuted)}
                    className="p-1.5 rounded-md hover:bg-bg-elevated text-muted hover:text-foreground transition-colors cursor-pointer"
                    title={p.isMuted ? 'Unmute' : 'Mute'}
                  >
                    {p.isMuted ? <FiVolumeX className="w-3.5 h-3.5" /> : <FiVolume2 className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => onCamera(p.id, !p.isCameraOff)}
                    className="p-1.5 rounded-md hover:bg-bg-elevated text-muted hover:text-foreground transition-colors cursor-pointer"
                    title={p.isCameraOff ? 'Turn camera on' : 'Turn camera off'}
                  >
                    {p.isCameraOff ? <FiVideoOff className="w-3.5 h-3.5" /> : <FiVideo className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => onRemove(p.id)}
                    className="p-1.5 rounded-md hover:bg-destructive/20 text-muted hover:text-destructive transition-colors cursor-pointer"
                    title="Remove"
                  >
                    <FiUserMinus className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
