import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_ALERT_STATE, type AlertState, type AlertStateEntry, type RecordedState } from './opsAlertEngine.js';

/**
 * Durable "what I last told a human" record for the alert engine (ABL-287).
 *
 * WHY THIS IS NOT ABL-288's SNAPSHOT STORE
 *
 * ABL-288 persists ops-status *readings* (raw bytes, freshness verdicts) as an
 * append-only JSONL time series. This file holds a different fact — one entry
 * per KPI, the last state we notified on — and re-deriving it from those
 * readings would be wrong in three ways, the first fatally:
 *
 *  1. A threshold change would silently rewrite history. Move `DISK_ERROR_RATIO`
 *     from 0.90 to 0.85 and the last stored reading at 87% re-derives from `ok`
 *     to `error`; the engine compares `error` against a previous that is *now
 *     also* `error`, sees no transition, and never fires — the threshold change
 *     suppressing exactly the alert it was made to produce. What we told
 *     someone is a historical fact and must be stored as one.
 *  2. The reading store lives on the disk it measures. An ENOSPC stops capture
 *     precisely when the disk alert matters most.
 *  3. Snapshot cadence (15 min) and alert cadence need not match.
 *
 * So: one small JSON object, no history, no retention, no downsampling.
 *
 * NOTHING HERE THROWS
 *
 * Its input is an arbitrary file on a host we do not control — absent on first
 * boot, truncated by a full disk, hand-edited, or written by an older build.
 * The same discipline the client's `migratePersisted()` holds to applies: a
 * bad blob degrades to "no memory" (which re-fires current breaches once —
 * noisy but correct) and never takes the scheduled check down with it. A
 * monitoring job that dies on its own state file is worse than one that
 * forgets.
 */

const DEFAULT_DB_PATH = '/data/energy_dashboard.db';

/**
 * Beside the database, matching where ABL-288 puts its snapshots — that
 * directory is the one path every deployment already has writable and
 * configured (`ENERGY_DB_PATH`), including the acceptance box whose bind mount
 * cannot host a WAL connection but takes ordinary file writes fine
 * (`config/writeDatabase.ts:13-18`).
 */
export function resolveAlertStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPS_ALERT_STATE_PATH;
  if (override) return override;
  return path.join(path.dirname(env.ENERGY_DB_PATH || DEFAULT_DB_PATH), 'ops-alert-state.json');
}

function isRecordedState(value: unknown): value is RecordedState {
  return value === 'ok' || value === 'warn' || value === 'error';
}

/**
 * Validates entry-by-entry rather than trusting the file's shape, and drops
 * only what is malformed. A single corrupt entry must not discard the six good
 * ones beside it and re-fire every other KPI.
 */
function parseAlertState(raw: string): AlertState {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return EMPTY_ALERT_STATE;

  const candidate = parsed as { version?: unknown; entries?: unknown };
  if (candidate.version !== 1) return EMPTY_ALERT_STATE;
  if (!Array.isArray(candidate.entries)) return EMPTY_ALERT_STATE;

  const entries: AlertStateEntry[] = [];
  for (const item of candidate.entries) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { key?: unknown; state?: unknown; firedAt?: unknown };
    if (typeof entry.key !== 'string' || entry.key.length === 0) continue;
    if (!isRecordedState(entry.state)) continue;
    if (typeof entry.firedAt !== 'string') continue;
    entries.push({ key: entry.key, state: entry.state, firedAt: entry.firedAt });
  }

  return { version: 1, entries };
}

export interface ReadAlertStateResult {
  state: AlertState;
  /** Non-null when the file existed but could not be used — worth one log line, not a crash. */
  warning: string | null;
}

export function readAlertState(
  filePath: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): ReadAlertStateResult {
  let raw: string;
  try {
    raw = readFile(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // A missing file is the normal first-boot path, not a warning.
    if (code === 'ENOENT') return { state: EMPTY_ALERT_STATE, warning: null };
    return {
      state: EMPTY_ALERT_STATE,
      warning: `could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    return { state: parseAlertState(raw), warning: null };
  } catch (err) {
    return {
      state: EMPTY_ALERT_STATE,
      warning: `could not parse ${filePath}, starting from no memory: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

export interface WriteAlertStateResult {
  ok: boolean;
  warning: string | null;
}

/**
 * Write-then-rename, so a crash or a full disk mid-write leaves the previous
 * record intact instead of a truncated one. A failed write is reported, never
 * thrown: the next tick then re-fires whatever is still breached, which is the
 * safe direction to fail — a duplicate alert beats a silent one.
 */
export function writeAlertState(
  filePath: string,
  state: AlertState,
  deps: {
    writeFile?: (p: string, data: string) => void;
    rename?: (from: string, to: string) => void;
    mkdir?: (dir: string) => void;
  } = {},
): WriteAlertStateResult {
  const {
    writeFile = (p, data) => fs.writeFileSync(p, data, 'utf8'),
    rename = (from, to) => fs.renameSync(from, to),
    mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }),
  } = deps;

  const tmpPath = `${filePath}.tmp`;
  try {
    mkdir(path.dirname(filePath));
    writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
    rename(tmpPath, filePath);
    return { ok: true, warning: null };
  } catch (err) {
    return {
      ok: false,
      warning: `could not persist alert state to ${filePath} (breached KPIs will re-notify next tick): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
