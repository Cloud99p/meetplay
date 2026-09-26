/**
 * Theme preference: DARK (the look the product shipped with) or LIGHT.
 *
 * Personal, not room state. Two people in the same call can want different
 * themes, so this lives in localStorage on the viewer's own machine and is
 * never sent to the server — the same reasoning as the caption display mode
 * (see Captions.tsx / MeetingRoom.tsx). Nothing here is carried over the
 * wire, so participants cannot disagree about it.
 *
 * The state lives in this module rather than inside a React component because
 * the toggle is rendered in more than one place (the meeting control bar and
 * the lobby). Two `useState` copies would drift apart the moment someone
 * toggled from the other one; subscribers keep every mounted toggle showing
 * the same value, and the `data-theme` attribute on <html> stays the single
 * source of truth for CSS.
 */

export type Theme = 'dark' | 'light';

export const THEMES: Theme[] = ['dark', 'light'];

/** Namespaced so it cannot collide with another app on the same origin. The
 *  identity/session keys in lib/identity.ts are separate concerns. */
export const THEME_KEY = 'meetplay.theme';

/** Dark is the default: it is the theme that already shipped, so nobody's look
 *  changes until they explicitly ask for it. */
export const DEFAULT_THEME: Theme = 'dark';

type Listener = (theme: Theme) => void;

const listeners = new Set<Listener>();

/**
 * Cached so getTheme() can back useSyncExternalStore, whose getSnapshot must
 * return a value that is stable across renders rather than re-reading storage
 * (a fresh value each call would loop).
 */
let current: Theme | null = null;

/** Anything unrecognised — including the null of a first visit — is the
 *  default. Deliberately not a "system preference" lookup: the product's
 *  identity is the dark UI, and inventing a third state would make the toggle
 *  impossible to reason about. */
export function resolveTheme(raw: string | null | undefined): Theme {
  return raw === 'light' ? 'light' : DEFAULT_THEME;
}

export function getTheme(): Theme {
  if (current === null) {
    // Guarded because this module is also loaded by the Node verify scripts
    // (react-dom/server), where there is no window.
    if (typeof window === 'undefined') return DEFAULT_THEME;
    try {
      current = resolveTheme(window.localStorage.getItem(THEME_KEY));
    } catch {
      // Storage can throw when disabled (private mode, blocked cookies).
      current = DEFAULT_THEME;
    }
  }
  return current;
}

/** Writes the theme onto <html>. index.css keys its whole palette off this
 *  attribute, so this one call is what actually repaints the app. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

export function setTheme(theme: Theme): void {
  current = theme;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage unavailable: the choice still applies to this page view, it
    // just will not survive a reload. Better than crashing the toggle.
  }
  applyTheme(theme);
  for (const listener of listeners) listener(theme);
}

export function otherTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

export function subscribeTheme(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
