// Persistent client identity — differentiates users across rooms/sessions.
// A stable userId is generated once and stored in localStorage; the display
// name is remembered so join forms prefill.

const USER_ID_KEY = 'meetplay_user_id';
const NAME_KEY = 'meetplay_display_name';

export function getUserId(): string {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(USER_ID_KEY, id);
  }
  return id;
}

export function getSavedName(): string | null {
  return localStorage.getItem(NAME_KEY);
}

export function saveName(name: string): void {
  localStorage.setItem(NAME_KEY, name);
}
