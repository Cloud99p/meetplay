/**
 * Room-name hygiene: users type these, so they are untrusted input.
 *
 * Why this exists: a security probe created a room with the name
 * `<script>alert(1)</script>` and the server stored and echoed it verbatim
 * (201, no cap). React escapes text nodes, so it was not exploitable on day
 * one — but a room name does not stay a text node. It reaches `<title>`,
 * link-preview cards, emails, PDF exports and logs, and every one of those is
 * a place where "the framework escapes it" stops being true. The cheapest
 * correct answer is to never store markup: strip what has no business in a
 * room name, and cap the length so a single room cannot cost 5000 chars of
 * render, storage or log volume.
 *
 * Markup is removed rather than escaped. Escaping would store `&lt;script&gt;`
 * and show it to the user literally, which is worse than the injection: the
 * name would look broken. Angle brackets have no legitimate use in a room
 * name, so they go.
 */

/** Longest room name we keep. Long enough for a sentence, short enough to render. */
export const MAX_ROOM_NAME_LENGTH = 120;

/** Names are free text, but control characters tear up logs and terminals. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const ANGLE_BRACKETS = /[<>]/g;

export interface CleanRoomNameResult {
  /** The value safe to store, or `undefined` if nothing usable was supplied. */
  value: string | undefined;
  /** True when the input had to be changed — useful for logging, never for auth. */
  altered: boolean;
}

/**
 * Normalise a client-supplied room name.
 *
 * Returns `undefined` for "no name given", which the store already treats as a
 * nameless room (the probe showed `{"name":null}` is a supported state). A name
 * that sanitises to nothing is treated as no name, not as an error: rejecting
 * it would break guests for no security benefit.
 */
export function cleanRoomName(raw: unknown): CleanRoomNameResult {
  if (typeof raw !== 'string') return { value: undefined, altered: false };

  const before = raw;
  const stripped = raw
    .replace(CONTROL_CHARS, '')
    .replace(ANGLE_BRACKETS, '')
    .trim()
    .slice(0, MAX_ROOM_NAME_LENGTH)
    .trim();

  return {
    value: stripped.length > 0 ? stripped : undefined,
    altered: stripped !== before,
  };
}
