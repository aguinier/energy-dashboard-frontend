import { describe, it, expect } from 'vitest';
import {
  appendSnapshot,
  parseSnapshotLines,
  pruneSnapshots,
  readSnapshots,
  resolveSnapshotConfig,
  serializeSnapshot,
  type OpsSnapshotConfig,
  type SnapshotFs,
} from './opsSnapshotStore.js';
import type { OpsSnapshot, OpsSideSnapshot } from './opsSnapshot.js';

const SIDE: OpsSideSnapshot = {
  reachable: true,
  latencyMs: 4,
  diskUsedBytes: 800,
  diskTotalBytes: 1000,
  rssBytes: 100,
  uptimeSeconds: 60,
  freshnessStatus: 'live',
  staleCountryCount: 0,
  commit: 'abc1234',
};

function snapshotAt(t: string): OpsSnapshot {
  return { t, local: { ...SIDE }, peer: { ...SIDE } };
}

/** In-memory `SnapshotFs`, so no test writes to a real disk. */
function memoryFs(initial: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initial };
  const mkdirs: string[] = [];
  const fs: SnapshotFs = {
    readFileSync: (file) => {
      if (!(file in files)) {
        const err = new Error(`ENOENT: no such file or directory, open '${file}'`) as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return files[file];
    },
    appendFileSync: (file, data) => {
      files[file] = (files[file] ?? '') + data;
    },
    writeFileSync: (file, data) => {
      files[file] = data;
    },
    renameSync: (from, to) => {
      files[to] = files[from];
      delete files[from];
    },
    mkdirSync: (dir) => {
      mkdirs.push(dir);
    },
  };
  return { fs, files, mkdirs };
}

const CONFIG: OpsSnapshotConfig = {
  path: '/data/ops-status-snapshots.jsonl',
  enabled: true,
  retentionDays: 14,
  intervalMinutes: 15,
};

describe('resolveSnapshotConfig', () => {
  it('defaults the file next to the database, keeps 14d, captures every 15m, and is on', () => {
    const config = resolveSnapshotConfig({ ENERGY_DB_PATH: '/data/energy_dashboard.db' } as NodeJS.ProcessEnv);

    expect(config.path.replace(/\\/g, '/')).toBe('/data/ops-status-snapshots.jsonl');
    expect(config.enabled).toBe(true);
    expect(config.retentionDays).toBe(14);
    expect(config.intervalMinutes).toBe(15);
  });

  it('honours an explicit path, retention and interval', () => {
    const config = resolveSnapshotConfig({
      ENERGY_DB_PATH: '/data/energy_dashboard.db',
      OPS_SNAPSHOT_PATH: '/var/log/ops.jsonl',
      OPS_SNAPSHOT_RETENTION_DAYS: '30',
      OPS_SNAPSHOT_INTERVAL_MINUTES: '5',
    } as NodeJS.ProcessEnv);

    expect(config.path).toBe('/var/log/ops.jsonl');
    expect(config.retentionDays).toBe(30);
    expect(config.intervalMinutes).toBe(5);
  });

  it('falls back to the defaults on unusable numbers rather than a zero interval or retention', () => {
    const config = resolveSnapshotConfig({
      OPS_SNAPSHOT_RETENTION_DAYS: 'forever',
      OPS_SNAPSHOT_INTERVAL_MINUTES: '0',
    } as NodeJS.ProcessEnv);

    expect(config.retentionDays).toBe(14);
    expect(config.intervalMinutes).toBe(15);
  });

  it.each(['false', 'FALSE', '0', 'off'])('treats OPS_SNAPSHOT_ENABLED=%s as off', (value) => {
    expect(resolveSnapshotConfig({ OPS_SNAPSHOT_ENABLED: value } as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  // docker-compose.yml passes all four as `${VAR:-}`, so an unset variable
  // arrives as an EMPTY STRING, not as undefined. Each has to land on its
  // default: an empty OPS_SNAPSHOT_PATH surviving as a path would write to the
  // container's working directory instead of /data, and an empty interval read
  // as 0 would schedule a capture on every tick.
  it('treats the empty strings docker passes for unset vars as unset', () => {
    const config = resolveSnapshotConfig({
      ENERGY_DB_PATH: '/data/energy_dashboard.db',
      OPS_SNAPSHOT_ENABLED: '',
      OPS_SNAPSHOT_INTERVAL_MINUTES: '',
      OPS_SNAPSHOT_RETENTION_DAYS: '',
      OPS_SNAPSHOT_PATH: '',
    } as NodeJS.ProcessEnv);

    expect(config.enabled).toBe(true);
    expect(config.intervalMinutes).toBe(15);
    expect(config.retentionDays).toBe(14);
    expect(config.path.replace(/\\/g, '/')).toBe('/data/ops-status-snapshots.jsonl');
  });
});

describe('parseSnapshotLines', () => {
  it('parses one snapshot per line and ignores blank lines', () => {
    const text = `${serializeSnapshot(snapshotAt('2026-08-01T00:00:00.000Z'))}\n${serializeSnapshot(snapshotAt('2026-08-01T00:15:00.000Z'))}`;

    const { snapshots, skippedLines } = parseSnapshotLines(text);

    expect(snapshots.map((s) => s.t)).toEqual(['2026-08-01T00:00:00.000Z', '2026-08-01T00:15:00.000Z']);
    expect(skippedLines).toBe(0);
  });

  it('skips a torn final line instead of throwing the whole history away', () => {
    const good = serializeSnapshot(snapshotAt('2026-08-01T00:00:00.000Z'));
    const { snapshots, skippedLines } = parseSnapshotLines(`${good}{"t":"2026-08-01T00:15`);

    expect(snapshots).toHaveLength(1);
    expect(skippedLines).toBe(1);
  });

  it('skips well-formed JSON that is not a snapshot', () => {
    const { snapshots, skippedLines } = parseSnapshotLines('{"hello":"world"}\n{"t":"not-a-date","local":{},"peer":{}}\n');

    expect(snapshots).toHaveLength(0);
    expect(skippedLines).toBe(2);
  });
});

describe('pruneSnapshots', () => {
  const now = new Date('2026-08-15T00:00:00.000Z');

  it('drops snapshots older than the retention window and sorts the rest oldest-first', () => {
    const kept = pruneSnapshots(
      [
        snapshotAt('2026-08-14T00:00:00.000Z'),
        snapshotAt('2026-07-01T00:00:00.000Z'),
        snapshotAt('2026-08-10T00:00:00.000Z'),
      ],
      now,
      14,
    );

    expect(kept.map((s) => s.t)).toEqual(['2026-08-10T00:00:00.000Z', '2026-08-14T00:00:00.000Z']);
  });
});

describe('readSnapshots', () => {
  it('reports a missing file as an empty history, not an error — that is a fresh deploy', () => {
    const { fs } = memoryFs();

    expect(readSnapshots(CONFIG, { fs })).toEqual({ snapshots: [], skippedLines: 0, error: null });
  });

  it('reports a genuine read failure as an error, never as a silent empty history', () => {
    const { fs } = memoryFs();
    const failing: SnapshotFs = {
      ...fs,
      readFileSync: () => {
        const err = new Error('EACCES: permission denied') as Error & { code: string };
        err.code = 'EACCES';
        throw err;
      },
    };

    const result = readSnapshots(CONFIG, { fs: failing });

    expect(result.snapshots).toEqual([]);
    expect(result.error).toContain('EACCES');
  });

  it('returns stored snapshots oldest-first', () => {
    const { fs } = memoryFs({
      [CONFIG.path]:
        serializeSnapshot(snapshotAt('2026-08-02T00:00:00.000Z')) +
        serializeSnapshot(snapshotAt('2026-08-01T00:00:00.000Z')),
    });

    expect(readSnapshots(CONFIG, { fs }).snapshots.map((s) => s.t)).toEqual([
      '2026-08-01T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
    ]);
  });
});

describe('appendSnapshot', () => {
  const now = new Date('2026-08-15T00:00:00.000Z');

  it('appends one line to a new file and creates its directory', () => {
    const { fs, files, mkdirs } = memoryFs();

    const result = appendSnapshot(snapshotAt('2026-08-15T00:00:00.000Z'), CONFIG, now, { fs });

    expect(result).toEqual({ written: true, pruned: 0, error: null });
    expect(files[CONFIG.path].trim().split('\n')).toHaveLength(1);
    expect(mkdirs[0].replace(/\\/g, '/')).toBe('/data');
  });

  it('appends without rewriting when nothing is past retention', () => {
    const existing = serializeSnapshot(snapshotAt('2026-08-14T00:00:00.000Z'));
    const { fs, files } = memoryFs({ [CONFIG.path]: existing });

    appendSnapshot(snapshotAt('2026-08-15T00:00:00.000Z'), CONFIG, now, { fs });

    expect(files[CONFIG.path].startsWith(existing)).toBe(true);
    expect(files[CONFIG.path].trim().split('\n')).toHaveLength(2);
  });

  it('rewrites the file, via a temp file, when the append pushes snapshots past retention', () => {
    const { fs, files } = memoryFs({
      [CONFIG.path]:
        serializeSnapshot(snapshotAt('2026-07-01T00:00:00.000Z')) +
        serializeSnapshot(snapshotAt('2026-08-14T00:00:00.000Z')),
    });

    const result = appendSnapshot(snapshotAt('2026-08-15T00:00:00.000Z'), CONFIG, now, { fs });

    expect(result.pruned).toBe(1);
    expect(files[`${CONFIG.path}.tmp`]).toBeUndefined();
    expect(parseSnapshotLines(files[CONFIG.path]).snapshots.map((s) => s.t)).toEqual([
      '2026-08-14T00:00:00.000Z',
      '2026-08-15T00:00:00.000Z',
    ]);
  });

  it('repairs a file with torn lines on the next append instead of accumulating them', () => {
    const { fs, files } = memoryFs({
      [CONFIG.path]: `${serializeSnapshot(snapshotAt('2026-08-14T00:00:00.000Z'))}{"t":"2026-08-1`,
    });

    const result = appendSnapshot(snapshotAt('2026-08-15T00:00:00.000Z'), CONFIG, now, { fs });

    expect(result.written).toBe(true);
    expect(parseSnapshotLines(files[CONFIG.path]).skippedLines).toBe(0);
  });

  it('reports an unwritable path rather than throwing into the scheduler', () => {
    const { fs } = memoryFs();
    const readonlyFs: SnapshotFs = {
      ...fs,
      appendFileSync: () => {
        throw new Error('EROFS: read-only file system');
      },
    };

    const result = appendSnapshot(snapshotAt('2026-08-15T00:00:00.000Z'), CONFIG, now, { fs: readonlyFs });

    expect(result.written).toBe(false);
    expect(result.error).toContain('EROFS');
  });

  it('reports written: false when the snapshot itself is older than the retention window', () => {
    const { fs } = memoryFs();

    const result = appendSnapshot(snapshotAt('2026-01-01T00:00:00.000Z'), CONFIG, now, { fs });

    expect(result.written).toBe(false);
  });
});
