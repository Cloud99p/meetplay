import { FiInfo } from 'react-icons/fi';

interface Props {
  visible: boolean;
  onDismiss: () => void;
}

export default function ConsentBanner({ visible, onDismiss }: Props) {
  if (!visible) return null;

  return (
    <div className="slide-down bg-warning/15 border-b border-warning/30 px-4 py-3">
      <div className="max-w-4xl mx-auto flex items-start gap-3">
        <FiInfo className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground">
            <strong>Captions and meeting games are now active.</strong> This meeting is being transcribed — transcripts are deleted when the meeting ends.
          </p>
        </div>
        <button
          onClick={onDismiss}
          className="flex-shrink-0 px-3 py-1.5 text-xs font-medium bg-warning/20 hover:bg-warning/30 text-warning rounded-md transition-colors cursor-pointer"
        >
          Got it
        </button>
      </div>
    </div>
  );
}