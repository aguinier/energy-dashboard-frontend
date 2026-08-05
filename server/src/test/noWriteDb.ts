/**
 * A `vi.mock` factory for `../config/writeDatabase.js`.
 *
 * `getWriteDb()` opens `ENERGY_DB_PATH` WRITABLE, lazily, on first use. The
 * route tests mount the whole `/api` router — which puts the token-gated write
 * routes in reach — so an accidental hit on one would open the real shared
 * database for writing. This turns that into a loud failure instead.
 *
 * Deliberately a module with NO imports of its own: it is loaded from inside a
 * `vi.mock` factory, and importing the harness (which pulls in the router
 * graph, which pulls in `writeDatabase.js`) from there would be circular.
 */
export function forbidWriteDb() {
  return {
    getWriteDb: () => {
      throw new Error('tests must never open a writable database handle');
    },
  };
}
