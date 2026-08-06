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

const PAUSED_AFTER_MS = 30_000;

export default function CaptionsOverlay({ captions, visible }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [recent, setRecent] = useState<Caption[]>([]);
  const [paused, setPaused] = useState(false);

  // Keep last 3 captions visible
  useEffect(() => {
    setRecent(captions.slice(-3));
  }, [captions]);

  // "Captions paused" when no caption:event for >30s (STT drop resilience)
  useEffect(() => {
    if (!visible) {
      setPaused(false);
      return;
    }
    if (captions.length === 0) return;

    const last = captions[captions.length - 1]?.timestamp ?? Date.now();
    const check = () => setPaused(Date.now() - last > PAUSED_AFTER_MS);
    check();
    const timer = setInterval(check, 5000);
    return () => clearInterval(timer);
  }, [captions, visible]);

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
        {paused && (
          <div className="px-3 py-1.5 rounded-lg bg-caption-bg/60 backdrop-blur-sm text-xs text-muted italic">
            Captions paused — waiting for the caption feed to resume…
          </div>
        )}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
