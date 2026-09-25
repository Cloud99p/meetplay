import { useEffect, useMemo, useRef, useState } from 'react';
import { FiChevronDown, FiEye, FiEyeOff, FiLayers, FiMic, FiMicOff, FiX } from 'react-icons/fi';
import { collapseCaptions } from '../../lib/stt/captionRows';
import type { MeetingState } from '../../hooks/useMeeting';

/**
 * How the transcript panel is shown. A personal display preference, not room
 * state — it never travels over the wire, so it cannot disagree between
 * participants the way a broadcast flag can.
 *   visible     -> opaque panel, docked to the right edge of the video area
 *   transparent -> same panel, see-through + blurred, so you can read and still
 *                  watch the video underneath
 *   hidden      -> not rendered at all
 */
export type TranscriptMode = 'visible' | 'transparent' | 'hidden';

export const TRANSCRIPT_MODES: TranscriptMode[] = ['visible', 'transparent', 'hidden'];

type Caption = MeetingState['captions'][number];

interface Props {
  captions: Caption[];
  mode: TranscriptMode;
  onModeChange: (mode: TranscriptMode) => void;
  /** Room-wide: the host has transcription on. Off means no captions will arrive. */
  transcriptionEnabled: boolean;
  isHost: boolean;
  onEnableTranscription?: () => void;
}

/** Below this confidence a line renders dimmed (same floor the server uses for games/recap). */
const LOW_CONFIDENCE = 0.5;
/** Distance from the bottom that still counts as "following the live edge". */
const STICK_SLOP_PX = 40;

const LABELS: Record<TranscriptMode, string> = {
  visible: 'Visible',
  transparent: 'Transparent',
  hidden: 'Hidden',
};

/**
 * The running transcript of the call.
 *
 * This is a display-only view of `state.captions`, collapsed via
 * `collapseCaptions` so the engine's interim/final narration of one sentence
 * does not stack up as duplicate lines. It never writes back to the array, so
 * games and the recap keep reading exactly what they always did.
 */
export default function TranscriptPanel({
  captions,
  mode,
  onModeChange,
  transcriptionEnabled,
  isHost,
  onEnableTranscription,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Following the live edge, until the reader scrolls up to read something.
  const [stick, setStick] = useState(true);

  const rows = useMemo(() => collapseCaptions(captions), [captions]);

  useEffect(() => {
    if (!stick) return;
    // scrollIntoView on a sentinel is smoother than scrollTop = scrollHeight
    // and does not fight the panel's own layout.
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [rows, stick]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStick(distance < STICK_SLOP_PX);
  };

  if (mode === 'hidden') return null;

  const transparent = mode === 'transparent';
  const shell = transparent
    ? 'bg-bg-surface/30 backdrop-blur-md border-border/50'
    : 'bg-bg-surface border-border';

  return (
    <div
      /* Docking: a bottom sheet on phones (a full-width overlay would blank the
         video) and a right-hand panel from the `sm` breakpoint up, so it never
         lands on top of the middle of the screen. */
      className={`absolute z-30 flex flex-col inset-x-0 bottom-0 max-h-[45%] rounded-t-xl border-t sm:rounded-none sm:border-t-0 sm:inset-x-auto sm:left-auto sm:right-0 sm:top-16 sm:bottom-0 sm:w-80 sm:max-h-none sm:border-l ${shell}`}
      role="log"
      aria-label="Meeting transcript"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/60 shrink-0">
        <FiLayers className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="text-xs font-medium uppercase tracking-wider text-muted">
          Transcript
        </span>
        <span className="text-[10px] text-muted/70 tabular-nums">
          {rows.length}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => {
            const next = TRANSCRIPT_MODES[(TRANSCRIPT_MODES.indexOf(mode) + 1) % TRANSCRIPT_MODES.length];
            onModeChange(next);
          }}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-foreground hover:bg-bg-elevated transition-colors cursor-pointer"
          title={`Transcript is ${LABELS[mode].toLowerCase()} — click to change`}
        >
          {mode === 'visible' ? <FiEye className="w-3.5 h-3.5" /> : <FiEyeOff className="w-3.5 h-3.5" />}
          {LABELS[mode]}
        </button>
        <button
          onClick={() => onModeChange('hidden')}
          className="w-7 h-7 grid place-items-center rounded-md text-foreground hover:bg-bg-elevated transition-colors cursor-pointer"
          aria-label="Hide transcript"
          title="Hide"
        >
          <FiX className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
      >
        {!transcriptionEnabled ? (
          <div className="text-xs text-muted space-y-2 py-2">
            <p className="flex items-center gap-2">
              <FiMicOff className="w-3.5 h-3.5 shrink-0" />
              Transcription is off — no transcript is being recorded.
            </p>
            {isHost && onEnableTranscription && (
              <button
                onClick={onEnableTranscription}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-primary text-on-primary text-xs font-medium cursor-pointer"
              >
                <FiMic className="w-3.5 h-3.5" />
                Turn on transcription
              </button>
            )}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted italic py-2">
            Listening — nothing captured yet.
          </p>
        ) : (
          rows.map((r, i) => {
            const prev = rows[i - 1];
            const showSpeaker = !prev || prev.speakerId !== r.speakerId;
            const lowConf = typeof r.confidence === 'number' && r.confidence < LOW_CONFIDENCE;
            return (
              <div
                key={r.key}
                className={`text-sm leading-snug ${r.live ? 'opacity-70' : ''} ${lowConf && !r.live ? 'opacity-60' : ''}`}
                title={lowConf ? `Low transcription confidence (${r.confidence?.toFixed(2)})` : undefined}
              >
                {showSpeaker && (
                  <div className="text-[11px] font-medium text-primary mb-0.5">
                    {r.speakerName ?? 'Speaker'}
                  </div>
                )}
                <span className="text-foreground/90">{r.text}</span>
                {r.live && <span className="ml-1 text-muted animate-pulse">…</span>}
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Jump to live edge — only while the reader has scrolled away */}
      {!stick && rows.length > 0 && (
        <button
          onClick={() => {
            setStick(true);
            bottomRef.current?.scrollIntoView({ block: 'end' });
          }}
          className="absolute bottom-10 right-4 flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-primary text-on-primary text-[11px] font-medium shadow-lg cursor-pointer"
        >
          <FiChevronDown className="w-3 h-3" />
          Jump to latest
        </button>
      )}

      {/* Same promise the consent banner makes, kept visible next to the text
          it applies to. */}
      <div className="px-3 py-2 border-t border-border/60 text-[10px] text-muted/70 shrink-0">
        Transcripts are deleted when the meeting ends.
      </div>
    </div>
  );
}
