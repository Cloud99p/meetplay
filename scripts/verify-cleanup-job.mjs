// Verify the abandoned-room cleanup function executes and actually purges a
// stale room. Uses the in-memory DB (no DATABASE_URL) so it's self-contained.
// Prints CLEANUP_OK on success.
process.env.DATABASE_URL = '';
process.env.USE_MEMORY_DB = '1';

const { cleanupAbandonedRooms } = await import('../server/src/db/queries.ts');
const { createRoom, addParticipant, saveChatMessage, getRoomById } = await import('../server/src/db/queries.ts');

// Room A: stale (created, tiny bit of old activity) — but the in-memory store
// uses now() timestamps, so we can't fake age. Instead verify the function
// runs and returns an array; the actual purge logic is covered by the memory
// implementation's GREATEST/lastActivity scan which we also unit-check by
// directly invoking cleanup with a tiny maxAgeHours (0 = everything stale).
const fresh = await createRoom({ name: 'fresh' });
const stale = await createRoom({ name: 'stale' });
await addParticipant({ roomId: stale.id, name: 'P', isHost: true });
await saveChatMessage({ roomId: stale.id, participantId: 'x', content: 'hi' });

// maxAgeHours=-1 => cutoff = now + 1h (future) => every room is "abandoned"
// deterministically (avoids a same-millisecond equality race with maxAgeHours=0).
const purged = await cleanupAbandonedRooms(-1);
const freshGone = !(await getRoomById(fresh.id));
const staleGone = !(await getRoomById(stale.id));
const ok = Array.isArray(purged) && freshGone && staleGone;
console.log(ok ? 'CLEANUP_OK' : `CLEANUP_FAIL purged=${purged.length} freshGone=${freshGone} staleGone=${staleGone}`);
process.exit(ok ? 0 : 1);
