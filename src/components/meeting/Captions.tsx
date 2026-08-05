import { useEffect, useRef, useState } from 'react';

interface Caption {
  speakerId: string;
  speakerName: string | null;
  text: string;
  isFinal: boolean;
  timestamp: number;
}

interface Props {
  captions: Caption[];
  visible: boolean;
}

export default function CaptionsOverlay({ captions, visible }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [recent, setRecent] = useState<Caption[]>([]);

  useEffect(() => {
    // Keep last 3 captions visible
    setRecent(captions.slice(-3));
  }, [captions]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [recent]);

  if (!visible || captions.length === 0) return null;

  return (
    <div className="absolute bottom-16 left-0 right-0 px-4 pointer-events-none">
      <div className="max-w-2xl mx-auto space-y-1">
        {recent.map((c, i) => (
          <div
            key={`${c.timestamp}-${i}`}
            className="caption-enter px-3 py-1.5 rounded-lg bg-caption-bg backdrop-blur-sm"
          >
            {c.speakerName && (
              <span className="text-xs font-medium text-primary mr-2">{c.speakerName}</span>
            )}
            <span className="text-sm text-foreground/90">{c.text}</span>
          </div>
        ))}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}