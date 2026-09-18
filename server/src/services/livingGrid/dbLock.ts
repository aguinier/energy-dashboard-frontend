/**
 * Telling "the database is busy right now" apart from "the query is wrong".
 *
 * On a workstation the shared replica is locked to every reader twice a day
 * while `able-db-sync` rebuilds it inside one transaction — 30 to 60 minutes
 * of planned maintenance that clears by itself. Answering that with a 500
 * presents a schedule as a breakage, and sends whoever is on call looking for
 * a bug that is not there.
 */

/**
 * SQLite reports the same event under two codes depending on who is looking.
 *
 * `SQLITE_BUSY` is the ordinary lock. `SQLITE_READONLY_ROLLBACK` is what a
 * reader inside a container bind mount sees instead: it cannot observe the
 * host writer's lock, so it reads the journal as hot and tries to roll it back
 * on a readonly handle (ABL-657). Both mean "come back shortly", and neither
 * means anything was written.
 */
export function isDatabaseLocked(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_READONLY_ROLLBACK';
}
