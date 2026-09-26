import { useCallback, useSyncExternalStore } from 'react';
import {
  getTheme,
  otherTheme,
  setTheme as writeTheme,
  subscribeTheme,
  type Theme,
} from '../lib/theme';

export interface UseThemeResult {
  /** The theme currently applied to this browser. */
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

/**
 * Reads and writes the per-person theme. Backed by the module store in
 * lib/theme.ts via useSyncExternalStore so every mounted toggle (lobby and
 * control bar) stays in sync without prop threading.
 *
 * The DOM attribute is repainted by the write path — a reader elsewhere never
 * needs to apply it, and an effect here would only add a frame of lag on load.
 */
export function useTheme(): UseThemeResult {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);

  const setTheme = useCallback((next: Theme) => {
    writeTheme(next);
  }, []);

  const toggleTheme = useCallback(() => {
    writeTheme(otherTheme(getTheme()));
  }, []);

  return { theme, setTheme, toggleTheme };
}
