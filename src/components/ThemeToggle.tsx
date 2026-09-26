import { FiMoon, FiSun } from 'react-icons/fi';
import { useTheme } from '../hooks/useTheme';

/**
 * Per-person dark/light switch.
 *
 * Lives at the top level of components/ rather than under meeting/, because it
 * is rendered in both the lobby and the meeting — it belongs to neither.
 *
 * Shows the icon of the theme you would GET by clicking (a sun while dark),
 * which is the convention a one-button toggle sets up, and says so in the
 * tooltip. It writes to localStorage only, so each participant controls their
 * own desktop and cannot change anyone else's.
 */
export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      onClick={toggleTheme}
      className="flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-bg-elevated hover:bg-border text-foreground transition-colors duration-150 cursor-pointer active:scale-95"
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
    >
      {theme === 'dark' ? <FiSun className="w-4 h-4" /> : <FiMoon className="w-4 h-4" />}
    </button>
  );
}
