import { useEffect, useMemo, useState } from 'react';
import { VideoTrack, useTracks, useRemoteParticipants, useLocalParticipant, type TrackReference } from '@livekit/components-react';
import { Track } from 'livekit-client';

interface Props {
  onSpeakerClick?: (participantId: string) => void;
  className?: string;
}

export default function VideoGrid({ onSpeakerClick, className = '' }: Props) {
  const remoteParticipants = useRemoteParticipants();
  const { localParticipant } = useLocalParticipant();
  const cameraTracks = useTracks([Track.Source.Camera]);
  const screenTracks = useTracks([Track.Source.ScreenShare, Track.Source.ScreenShareAudio]);
  const [cols, setCols] = useState(2);

  const participantCount = remoteParticipants.length + 1;

  useEffect(() => {
    if (participantCount <= 2) setCols(participantCount);
    else if (participantCount <= 4) setCols(2);
    else if (participantCount <= 6) setCols(3);
    else setCols(Math.min(4, Math.ceil(Math.sqrt(participantCount))));
  }, [participantCount]);

  const tiles = useMemo(() => {
    const localId = localParticipant?.identity ?? 'local';
    return [
      {
        participantId: localId,
        isLocal: true,
        name: 'You',
      },
      ...remoteParticipants.map((p) => ({
        participantId: p.identity,
        isLocal: false,
        name: p.name || p.identity,
      })),
    ];
  }, [remoteParticipants, localParticipant]);

  // Map participant identity -> camera track ref (if published AND not muted)
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

  // Map participant identity -> active screen-share video track
  const screenByParticipant = useMemo(() => {
    const map = new Map<string, TrackReference>();
    for (const t of screenTracks) {
      if (!t.publication) continue;
      // Only the video share (ScreenShareAudio is the mic pick-up track)
      if (t.source !== Track.Source.ScreenShare) continue;
      if (t.publication.isMuted) continue;
      if (!map.has(t.participant.identity)) {
        map.set(t.participant.identity, t);
      }
    }
    return map;
  }, [screenTracks]);

  // First sharer wins the spotlight (LiveKit rooms rarely have multiple)
  const activeShareEntry = [...screenByParticipant.entries()][0];
  const activeShare = activeShareEntry?.[1];
  const sharerName =
    activeShareEntry?.[0] === (localParticipant?.identity ?? 'local')
      ? 'You'
      : remoteParticipants.find((p) => p.identity === activeShareEntry?.[0])?.name ??
        activeShareEntry?.[0] ??
        '';

  const cameraGrid = (
    <div
      className="grid gap-2 flex-1 min-h-0"
      style={{
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${Math.ceil(tiles.length / cols)}, 1fr)`,
      }}
    >
      {tiles.map((tile) => (
        <VideoTile
          key={tile.participantId}
          isLocal={tile.isLocal}
          name={tile.name}
          trackRef={trackByParticipant.get(tile.participantId)}
          onClick={() => onSpeakerClick?.(tile.participantId)}
        />
      ))}
    </div>
  );

  // Someone is presenting: show the shared screen big, cameras below
  if (activeShare) {
    return (
      <div className={`flex flex-col h-full gap-2 ${className}`}>
        <div className="relative flex-[2] min-h-0 rounded-lg overflow-hidden bg-black border border-border">
          <VideoTrack trackRef={activeShare} className="w-full h-full object-contain" />
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-2">
            <span className="text-xs font-medium text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
              {sharerName} is presenting
            </span>
          </div>
        </div>
        {cameraGrid}
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full min-h-0 ${className}`}>
      {cameraGrid}
    </div>
  );
}

function VideoTile({
  isLocal,
  name,
  trackRef,
  onClick,
}: {
  isLocal: boolean;
  name: string;
  trackRef?: TrackReference;
  onClick: () => void;
}) {
  // When the camera is off (or mid-switch) LiveKit keeps the track around
  // but muted — render the initial avatar instead of a black frame.
  const cameraOn = Boolean(
    trackRef && trackRef.publication && !trackRef.publication.isMuted,
  );

  return (
    <div
      onClick={onClick}
      className="relative rounded-lg overflow-hidden bg-bg-elevated border border-border cursor-pointer hover:border-primary/50 transition-colors group"
    >
      {cameraOn ? (
        <VideoTrack trackRef={trackRef} className="w-full h-full object-cover" />
      ) : (
        <div className="flex items-center justify-center h-full bg-bg-elevated">
          <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center">
            <span className="text-primary text-lg font-heading font-semibold">
              {name.charAt(0).toUpperCase()}
            </span>
          </div>
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
        <span className="text-xs font-medium text-white">
          {name}{isLocal ? ' (You)' : ''}
        </span>
      </div>
    </div>
  );
}
