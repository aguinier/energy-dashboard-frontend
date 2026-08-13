/**
 * The *shape* of a read handle on the energy database — and nothing that opens
 * one.
 *
 * Same split as `keys/apiKeyStore.ts` against `keys/sqliteApiKeyStore.ts`, and
 * for the same reason: `publicApp.ts` must be able to name what it needs
 * without `better-sqlite3` appearing in its import graph. `publicAppGraph.test.ts`
 * pins that, and ABL-304's argument is that the isolation is only worth having
 * while it is checked.
 *
 * So this module is types only. `sqliteEnergySource.ts` implements it, and
 * `publicIndex.ts` — the entrypoint, not the app — decides which implementation
 * a process gets.
 *
 * ## Why this is a SQL-carrying interface rather than a per-query method
 *
 * `all(sql, params)` looks lax next to `ApiKeyDirectory.findByPrefix()`. It is
 * deliberate, and the alternative is worse here:
 *
 * - The queries this serves are **windowed reads over one zone**, all built by
 *   four repo modules in this directory from literal SQL with bound parameters.
 *   No caller outside `v1/data/` holds one of these handles, and no request
 *   value is ever interpolated into a statement — every one is a `?`.
 * - Declaring one method per query would put the repo layer's SQL in this file,
 *   which is the file that must stay driver-free. The SQL would then live one
 *   module further from the measurements that justify it (the index seeks, the
 *   `LENGTH()=19` exclusion), which is where it is actually reviewable.
 *
 * The handle is **readonly** at the driver, so the worst a mistake in a repo can
 * do is answer the wrong question — never write to a database this process does
 * not own.
 */

/** What may be bound to a `?`. Deliberately not `unknown`: a query takes scalars. */
export type SqlParam = string | number;

/**
 * A readonly query surface.
 *
 * Both methods are synchronous because `better-sqlite3` is, and pretending
 * otherwise would add an await boundary that buys nothing and hides the fact
 * that a slow read blocks the process (the reason `services/readQueryWorker.ts`
 * exists on the private side).
 */
export interface EnergyQuery {
  all<Row>(sql: string, params?: readonly SqlParam[]): Row[];
  get<Row>(sql: string, params?: readonly SqlParam[]): Row | undefined;
}

/** A query surface with a lifecycle. The entrypoint owns closing it. */
export interface EnergyDataSource extends EnergyQuery {
  close(): void;
}
