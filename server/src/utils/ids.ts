/**
 * UUID shape check for ids that arrive from clients.
 *
 * Why this exists: the in-memory store accepts ANY string as a key, so a bogus id
 * works fine in dev — and Postgres answers with
 * `invalid input syntax for type uuid: "not-a-uuid"` (SQLSTATE 22P02) the moment
 * the app runs on the real database. That produced a 500 on an UNAUTHENTICATED
 * endpoint (`POST /api/rooms/:id/join`) and echoed the driver's error back to the
 * caller. Same class as the caption bug (synthetic speaker id `'local'`), which is
 * why the check lives in one place and is applied at every boundary.
 *
 * Usage: validate route params and message payload ids before they reach a query.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
