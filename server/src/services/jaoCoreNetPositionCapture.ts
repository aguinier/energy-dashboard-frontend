import type { Database as DatabaseType } from 'better-sqlite3';
import {
  parseJaoCoreNetPositionResponse,
  storeCoreNetPositionRows,
  type CoreNetPositionRow,
} from './coreNetPositionService.js';

/**
 * Verified working 2026-08-11 (67,811 bytes for one day, unauthenticated).
 * See `coreNetPositionService.ts` for the full response shape and why only
 * 12 of its 23 `hub_*` fields are stored.
 */
const JAO_NET_POSITION_URL = 'https://publicationtool.jao.eu/core/api/data/netPos';

/**
 * Thin network wrapper — the ONLY function in this module that touches the
 * network. `fetchImpl` defaults to the global `fetch` (Node 18+, already
 * used elsewhere in this server: `release/checkUnmergedWork.ts`) and is
 * injectable so tests never make a live call, matching how
 * `runForecastVintageArchiveCapture` injects its worker rather than hitting
 * a real thread in tests.
 */
export async function fetchJaoCoreNetPosition(
  fromUtc: string,
  toUtc: string,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const url = `${JAO_NET_POSITION_URL}?FromUtc=${encodeURIComponent(fromUtc)}&ToUtc=${encodeURIComponent(toUtc)}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`JAO netPos request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export interface CoreNetPositionCaptureResult {
  /** Rows parsed out of the response (12 Core zones x intervals returned). */
  parsed: number;
  /** New rows actually written — a re-capture over an already-seen window is 0. */
  inserted: number;
}

/**
 * Fetch one window from JAO, parse it, and store whatever is new.
 *
 * The only production caller is `workers/captureCoreNetPositionWorker.ts`,
 * on its own writable connection, off Express's request-handling thread —
 * see that file and `coreNetPositionScheduler.ts` for why. `db` and
 * `fetchImpl` are both parameters (rather than this module reaching for a
 * shared connection or the global `fetch` directly) purely so this function
 * itself stays synchronously-testable-in-spirit: one call, one stubbed
 * network response, one in-memory database, no worker thread required to
 * exercise the logic.
 */
export async function captureCoreNetPosition(
  db: DatabaseType,
  fromUtc: string,
  toUtc: string,
  options: {
    fetchedAt?: string;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<CoreNetPositionCaptureResult> {
  const { fetchedAt = new Date().toISOString(), fetchImpl = fetch } = options;

  const raw = await fetchJaoCoreNetPosition(fromUtc, toUtc, fetchImpl);
  const rows: CoreNetPositionRow[] = parseJaoCoreNetPositionResponse(raw);
  const inserted = storeCoreNetPositionRows(db, rows, fetchedAt);

  return { parsed: rows.length, inserted };
}
