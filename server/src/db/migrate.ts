// Idempotent schema migrations, applied automatically at server startup.
//
// No manual psql / init.sql step is needed no matter where Postgres runs
// (Docker, Railway, Render, managed DB, ...). Every statement must be safe
// to run repeatedly — prefer `ADD COLUMN IF NOT EXISTS` / `CREATE ... IF NOT
// EXISTS` so a redeploy on an old or new schema is always a no-op success.
//
// Add new schema changes as new entries at the END of the list.
const MIGRATIONS: string[] = [
  // 2026-08-06 — host camera-off moderation flag (participant:camera event)
  `ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_camera_off BOOLEAN DEFAULT false`,

  // 2026-08-08 — captions/transcription ON by default (main attraction):
  // new rooms start with transcription enabled so the demo works instantly.
  // Existing rooms are flipped on too — captions are the site's main feature
  // and the host can still toggle off per-room if they want.
  `ALTER TABLE rooms ALTER COLUMN transcription_enabled SET DEFAULT true`,
  `UPDATE rooms SET transcription_enabled = true WHERE transcription_enabled IS NULL OR transcription_enabled = false`,
];

export async function runMigrations(): Promise<void> {
  // Lazy import so memory-mode deployments never load the `pg` package.
  const { pool } = await import('./pgQueries.js');
  for (const sql of MIGRATIONS) {
    try {
      await pool.query(sql);
      console.log('[migrate] ok:', sql.replace(/\s+/g, ' ').slice(0, 100));
    } catch (e) {
      console.error('[migrate] failed:', sql.replace(/\s+/g, ' ').slice(0, 100), '-', (e as Error)?.message ?? e);
      throw e;
    }
  }
}
