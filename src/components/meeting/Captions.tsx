import { useEffect, useMemo, useRef, useState } from 'react';
import { collapseCaptions, type CaptionLike } from '../../lib/stt/captionRows';

/**
 * How the ON-SCREEN CAPTIONS are drawn. This is not a panel — it controls the
 * caption text that sits at the bottom-centre of the video, which is the whole
 * point of the setting:
 *   visible     -> solid pills (the default look)
 *   transparent -> see-through pills, so the video reads through the text
 *   hidden      -> no captions for me
 *
 * A personal display preference (the caller persists it in localStorage), never
 * room state, so it cannot disagree between participants the way a broadcast
 * flag can.
 */
export type TranscriptMode = 'visible' | 'transparent' | 'hidden';

export const TRANSCRIPT_MODES: TranscriptMode[] = ['visible', 'transparent', 'hidden'];

type Caption = CaptionLike;

interface Props {
  captions: Caption[];
  /** Display mode. `hidden` renders nothing at all. */
  mode: TranscriptMode;
}

const PAUSED_AFTER_MS = 30_000;
/** Captions below this confidence render dimmed (server drops them from games/recap at the same floor). */
const LOW_CONFIDENCE = 0.5;

export default function CaptionsOverlay({ captions, mode }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const hidden = mode === 'hidden';

  // The last 3 COLLAPSED captions, derived DURING RENDER rather than stored in
  // state and filled from an effect. Two reasons:
  //   1. correctness — computing this in an effect derives it after paint, so
  //      the first frame after a caption update showed the previous list;
  //   2. it is what makes the overlay testable without a DOM, since effects do
  //      not run under react-dom/server.
  // Collapsing matters: the engine emits an interim per update plus a final, so
  // the raw array holds several overlapping renderings of one sentence and this
  // overlay used to stack them (the "same words three times" bug).
  const recent = useMemo(() => collapseCaptions(captions).slice(-3), [captions]);

  // "Captions paused" when no caption:event for >30s (STT drop resilience)
  useEffect(() => {
    if (hidden) {
      setPaused(false);
      return;
    }
    if (captions.length === 0) return;

    const last = captions[captions.length - 1]?.timestamp ?? Date.now();
    const check = () => setPaused(Date.now() - last > PAUSED_AFTER_MS);
    check();
    const timer = setInterval(check, 5000);
    return () => clearInterval(timer);
  }, [captions, hidden]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [recent]);

  if (hidden || recent.length === 0) return null;

  const transparent = mode === 'transparent';
  // See-through pill: much lower alpha plus a slight blur so the video reads
  // through the text. The solid mode keeps the original token untouched.
  const pill = transparent ? 'bg-caption-bg/20 backdrop-blur-sm' : 'bg-caption-bg';
  const pausedPill = transparent
    ? 'bg-caption-bg/20 backdrop-blur-sm'
    : 'bg-caption-bg/60 backdrop-blur-sm';

  return (
    <div className="absolute bottom-16 left-0 right-0 px-4 pointer-events-none">
      <div className="max-w-2xl mx-auto space-y-1">
        {recent.map((c) => {
          const lowConf = typeof c.confidence === 'number' && c.confidence < LOW_CONFIDENCE;
          return (
            <div
              key={c.key}
              className={`caption-enter px-3 py-1.5 rounded-lg transition-opacity ${
                lowConf ? `${pill} opacity-50` : pill
              }`}
              title={lowConf ? `Low transcription confidence (${c.confidence?.toFixed(2)})` : undefined}
            >
              {c.speakerName && (
                <span className="text-xs font-medium text-primary mr-2">{c.speakerName}</span>
              )}
              <span className="text-sm text-foreground/90">{c.text}</span>
            </div>
          );
        })}
        {paused && (
          <div className={`px-3 py-1.5 rounded-lg text-xs text-muted italic ${pausedPill}`}>
            Captions paused — waiting for the caption feed to resume…
          </div>
        )}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
