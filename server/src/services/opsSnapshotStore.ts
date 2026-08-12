import fs from 'node:fs';
import path from 'node:path';
import type { OpsSnapshot } from './opsSnapshot.js';

/**
 * Append-only JSONL store for ops-status snapshots (ABL-288).
 *
 * WHY A FILE AND NOT THE DATABASE
 *
 * The SQLite database is shared with `energy-data-gathering`; adding a table
 * to it is a schema change to somebody else's database and is out of bounds
 * for this repo. It is also the wrong medium here: the deployed Windows
 * acceptance host cannot open a WAL connection at all — its bind-mounted
 * filesystem has no shared-memory `-shm` support, see
 * `../config/writeDatabase.ts:13-18` — while a plain append to a file on that
 * same mount works. One line per snapshot, one `appendFileSync` per capture.
 *
 * WHY MALFORMED LINES ARE SKIPPED, NOT THROWN ON
 *
 * A process killed mid-append leaves a torn final line. That must cost the
 * history view one point, not the whole endpoint, so `parseSnapshotLines`
 * drops anything it cannot parse and reports how many it dropped rather than
 * failing.
 *
 * The store never invents a reading: a window with no snapshots comes back
 * empty, and a file that cannot be read comes back empty *with the error*,
 * so the page can say why it is blank instead of drawing a flat line at zero.
 */

export interface OpsSnapshotConfig {
  /** Absolute path of the JSONL file. */
  path: string;
  /** False when `OPS_SNAPSHOT_ENABLED` is explicitly off — no capture, reads still served. */
  enabled: boolean;
  retentionDays: number;
  intervalMinutes: number;
}

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_FILENAME = 'ops-status-snapshots.jsonl';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Pure: where snapshots live and how often they are taken, for a given env.
 *
 * The default path sits next to the database — the `/data` volume in Docker
 * (`docker/docker-compose.yml`), which is already mounted read-write for the
 * weather-snapshot endpoint — because that is the one directory this process
 * is known to be able to write on every deployment. It is a *separate file*
 * owned by this repo, not a change to the shared database.
 *
 * Enabled by default, unlike the two DB-writing schedulers
 * (`coreNetPositionScheduler.ts`, `forecastVintageArchiveScheduler.ts`) which
 * are gated on explicit env vars: those write into the shared database, where
 * flipping ingest on is its own coordinated decision. This writes only its own
 * file, and a trend that needs a separate deploy-time flip before it starts
 * accumulating is a trend nobody has when they first need it. An unwritable
 * path degrades to "history unavailable, here is the error"; it never crashes
 * the process or blanks the live KPIs.
 */
export function resolveSnapshotConfig(env: NodeJS.ProcessEnv = process.env): OpsSnapshotConfig {
  const dbPath = env.ENERGY_DB_PATH || '/data/energy_dashboard.db';
  const configured = env.OPS_SNAPSHOT_PATH?.trim();
  const enabledRaw = env.OPS_SNAPSHOT_ENABLED?.trim().toLowerCase();

  return {
    path: configured || path.join(path.dirname(dbPath), DEFAULT_FILENAME),
    enabled: !(enabledRaw === 'false' || enabledRaw === '0' || enabledRaw === 'off'),
    retentionDays: positiveNumber(env.OPS_SNAPSHOT_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
    intervalMinutes: positiveNumber(env.OPS_SNAPSHOT_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES),
  };
}

export interface ParsedSnapshots {
  snapshots: OpsSnapshot[];
  /** Lines that were not parseable JSON, or were JSON without a usable `t`. */
  skippedLines: number;
}

/** Pure: JSONL text in, snapshots out, damaged lines counted rather than thrown on. */
export function parseSnapshotLines(text: string): ParsedSnapshots {
  const snapshots: OpsSnapshot[] = [];
  let skippedLines = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as OpsSnapshot;
      if (typeof parsed?.t !== 'string' || Number.isNaN(Date.parse(parsed.t)) || !parsed.local || !parsed.peer) {
        skippedLines += 1;
        continue;
      }
      snapshots.push(parsed);
    } catch {
      skippedLines += 1;
    }
  }

  return { snapshots, skippedLines };
}

/** Pure: one snapshot as the exact line written to the file, newline included. */
export function serializeSnapshot(snapshot: OpsSnapshot): string {
  return `${JSON.stringify(snapshot)}\n`;
}

/** Pure: snapshots within `retentionDays` of `now`, oldest first. */
export function pruneSnapshots(
  snapshots: OpsSnapshot[],
  now: Date,
  retentionDays: number,
): OpsSnapshot[] {
  const cutoff = now.getTime() - retentionDays * MS_PER_DAY;
  return snapshots
    .filter((s) => Date.parse(s.t) >= cutoff)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

/** The slice of `node:fs` this store needs, injectable so tests never touch a real disk. */
export interface SnapshotFs {
  readFileSync: (file: string, encoding: 'utf8') => string;
  appendFileSync: (file: string, data: string) => void;
  writeFileSync: (file: string, data: string) => void;
  renameSync: (from: string, to: string) => void;
  mkdirSync: (dir: string, options: { recursive: true }) => void;
}

const realFs: SnapshotFs = {
  readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
  appendFileSync: (file, data) => fs.appendFileSync(file, data),
  writeFileSync: (file, data) => fs.writeFileSync(file, data),
  renameSync: (from, to) => fs.renameSync(from, to),
  mkdirSync: (dir, options) => {
    fs.mkdirSync(dir, options);
  },
};

function isNotFound(error: unknown): boolean {
  return (error as { code?: string })?.code === 'ENOENT';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ReadSnapshotsResult {
  snapshots: OpsSnapshot[];
  skippedLines: number;
  /** `null` when the file was read, or does not exist yet (an empty history, not a fault). */
  error: string | null;
}

/**
 * Every snapshot on disk, oldest first.
 *
 * A missing file is an empty history with no error — that is the state of
 * every environment for the first fifteen minutes after a deploy. Any other
 * failure (permissions, a directory where the file should be) comes back as
 * an error string with an empty list, never as a silent empty history.
 */
export function readSnapshots(
  config: OpsSnapshotConfig,
  deps: { fs?: SnapshotFs } = {},
): ReadSnapshotsResult {
  const io = deps.fs ?? realFs;
  let text: string;
  try {
    text = io.readFileSync(config.path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return { snapshots: [], skippedLines: 0, error: null };
    return { snapshots: [], skippedLines: 0, error: message(error) };
  }

  const { snapshots, skippedLines } = parseSnapshotLines(text);
  return {
    snapshots: snapshots.sort((a, b) => Date.parse(a.t) - Date.parse(b.t)),
    skippedLines,
    error: null,
  };
}

export interface AppendSnapshotResult {
  written: boolean;
  /** How many expired snapshots this append dropped from the file. */
  pruned: number;
  error: string | null;
}

/**
 * Appends one snapshot, pruning anything past the retention window.
 *
 * The common case is a single `appendFileSync` — O(1) work per capture. Only
 * when the retention cutoff actually drops something does this rewrite the
 * file, and it does that via a temp file plus `rename` so a crash mid-rewrite
 * cannot leave a truncated history behind.
 *
 * Never throws: a capture that cannot be persisted is reported and logged by
 * the scheduler, and must not take the process (or the live status endpoint,
 * which shares this file) down with it.
 */
export function appendSnapshot(
  snapshot: OpsSnapshot,
  config: OpsSnapshotConfig,
  now: Date = new Date(),
  deps: { fs?: SnapshotFs } = {},
): AppendSnapshotResult {
  const io = deps.fs ?? realFs;

  try {
    io.mkdirSync(path.dirname(config.path), { recursive: true });

    const existing = readSnapshots(config, { fs: io });
    if (existing.error !== null) return { written: false, pruned: 0, error: existing.error };

    const kept = pruneSnapshots([...existing.snapshots, snapshot], now, config.retentionDays);
    const pruned = existing.snapshots.length + 1 - kept.length;
    // A snapshot older than the retention window is dropped by the same prune
    // that drops the rest, so `written` reports whether THIS reading survived
    // — not merely whether the file was touched.
    const written = kept.includes(snapshot);

    if (pruned > 0 || existing.skippedLines > 0) {
      const tempPath = `${config.path}.tmp`;
      io.writeFileSync(tempPath, kept.map(serializeSnapshot).join(''));
      io.renameSync(tempPath, config.path);
    } else {
      io.appendFileSync(config.path, serializeSnapshot(snapshot));
    }

    return { written, pruned: Math.max(pruned, 0), error: null };
  } catch (error) {
    return { written: false, pruned: 0, error: message(error) };
  }
}
