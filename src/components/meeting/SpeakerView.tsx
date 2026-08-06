import { useMemo } from 'react';
import { VideoTrack, useTracks, useRemoteParticipants, type TrackReference } from '@livekit/components-react';
import { Track } from 'livekit-client';

interface Props {
  activeSpeakerId?: string | null;
  className?: string;
}

export default function SpeakerView({ activeSpeakerId, className = '' }: Props) {
  const remoteParticipants = useRemoteParticipants();
  const cameraTracks = useTracks([Track.Source.Camera]);

  const trackByParticipant = useMemo(() => {
    const map = new Map<string, TrackReference>();
    for (const t of cameraTracks) {
      // Skip placeholder tracks (no actual publication yet)
      if (!t.publication) continue;
      // Skip muted tracks (camera off) so the tile shows the avatar, not black
      if (t.publication.isMuted) continue;
      if (!map.has(t.participant.identity)) {
        map.set(t.participant.identity, t);
      }
    }
    return map;
  }, [cameraTracks]);

  const activeParticipant = activeSpeakerId
    ? remoteParticipants.find((p) => p.identity === activeSpeakerId)
    : null;

  const speaker = activeParticipant || remoteParticipants[0];
  const speakerTrack = speaker ? trackByParticipant.get(speaker.identity) : undefined;

  const strip = remoteParticipants.filter((p) => p.identity !== speaker?.identity);

  return (
    <div className={`flex flex-col h-full gap-2 ${className}`}>
      {/* Main speaker */}
      <div className="flex-1 relative rounded-lg overflow-hidden bg-bg-elevated border border-border">
        {speaker && speakerTrack ? (
          <VideoTrack trackRef={speakerTrack} className="w-full h-full object-cover" />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mx-auto mb-2">
                <span className="text-primary text-2xl font-heading font-semibold">
                  {(speaker?.name || '?').charAt(0).toUpperCase()}
                </span>
              </div>
              <p className="text-muted text-sm">{speaker ? speaker.name : 'Waiting for participants…'}</p>
            </div>
          </div>
        )}
        {speaker && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-4 py-3">
            <span className="text-sm font-medium text-white">{speaker.name}</span>
          </div>
        )}
      </div>

      {/* Filmstrip of other participants */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {strip.length === 0 && (
          <p className="text-xs text-muted px-2 py-2">No other participants</p>
        )}
        {strip.map((p) => {
          const track = trackByParticipant.get(p.identity);
          return (
            <div key={p.identity} className="w-32 h-20 flex-shrink-0 relative rounded-md overflow-hidden bg-bg-elevated border border-border">
              {track ? (
                <VideoTrack trackRef={track} className="w-full h-full object-cover" />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <div className="w-8 h-8 rounded-full bg-secondary/20 flex items-center justify-center">
                    <span className="text-secondary text-xs font-heading font-semibold">
                      {p.name?.charAt(0).toUpperCase() || '?'}
                    </span>
                  </div>
                </div>
              )}
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1">
                <span className="text-[10px] text-white truncate block">{p.name || p.identity}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}