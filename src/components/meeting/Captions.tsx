import { useEffect, useMemo, useRef, useState } from 'react';
import { collapseCaptions, type CaptionLike } from '../../lib/stt/captionRows';

/**
 * Whether the ON-SCREEN CAPTIONS are drawn. Two states, deliberately:
 *   visible -> the caption pills at the bottom-centre of the video
 *   hidden  -> no captions for me
 *
 * A third "transparent" state was tried and removed: in practice nobody wanted
 * a middle setting, and the setting was never meant to open a panel — it
 * controls this text, not a sidebar.
 *
 * A personal display preference (the caller persists it in localStorage), never
 * room state, so it cannot disagree between participants.
 */
export type TranscriptMode = 'visible' | 'hidden';

export const TRANSCRIPT_MODES: TranscriptMode[] = ['visible', 'hidden'];

/**
 * Reads a persisted preference, including the retired `transparent` value: anyone
 * who had chosen see-through captions keeps seeing captions rather than landing
 * in a third state that no longer exists. Anything unrecognised stays hidden.
 */
export function resolveTranscriptMode(raw: string | null | undefined): TranscriptMode {
  if (raw === 'visible' || raw === 'transparent') return 'visible';
  return 'hidden';
}

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
    if (mode === 'hidden') {
      setPaused(false);
      return;
    }
    if (captions.length === 0) return;

    const last = captions[captions.length - 1]?.timestamp ?? Date.now();
    const check = () => setPaused(Date.now() - last > PAUSED_AFTER_MS);
    check();
    const timer = setInterval(check, 5000);
    return () => clearInterval(timer);
  }, [captions, mode]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [recent]);

  if (mode === 'hidden' || recent.length === 0) return null;

  return (
    <div className="absolute bottom-16 left-0 right-0 px-4 pointer-events-none">
      <div className="max-w-2xl mx-auto space-y-1">
        {recent.map((c) => {
          const lowConf = typeof c.confidence === 'number' && c.confidence < LOW_CONFIDENCE;
          return (
            <div
              key={c.key}
              className={`caption-enter px-3 py-1.5 rounded-lg bg-caption-bg transition-opacity ${
                lowConf ? 'opacity-50' : ''
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
          <div className="px-3 py-1.5 rounded-lg bg-caption-bg/60 backdrop-blur-sm text-xs text-muted italic">
            Captions paused — waiting for the caption feed to resume…
          </div>
        )}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
