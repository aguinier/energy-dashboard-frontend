import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveAlertStatePath, readAlertState, writeAlertState } from './opsAlertStateStore.js';
import type { AlertState } from './opsAlertEngine.js';

function enoent(): never {
  const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
}

const VALID: AlertState = {
  version: 1,
  entries: [{ key: 'local:disk', state: 'warn', firedAt: '2026-08-12T12:36:00.000Z' }],
};

describe('resolveAlertStatePath', () => {
  it('defaults to sitting beside the database', () => {
    expect(resolveAlertStatePath({ ENERGY_DB_PATH: '/data/energy_dashboard.db' })).toBe(
      path.join('/data', 'ops-alert-state.json'),
    );
  });

  it('honours an explicit override', () => {
    expect(
      resolveAlertStatePath({ OPS_ALERT_STATE_PATH: '/var/lib/able/alerts.json', ENERGY_DB_PATH: '/data/x.db' }),
    ).toBe('/var/lib/able/alerts.json');
  });

  it('falls back to the container default when ENERGY_DB_PATH is unset', () => {
    expect(resolveAlertStatePath({})).toBe(path.join('/data', 'ops-alert-state.json'));
  });
});

describe('readAlertState — never throws', () => {
  it('reads a valid record back', () => {
    const { state, warning } = readAlertState('/x.json', () => JSON.stringify(VALID));
    expect(state).toEqual(VALID);
    expect(warning).toBeNull();
  });

  it('treats a missing file as first boot, with no warning', () => {
    const { state, warning } = readAlertState('/x.json', enoent);
    expect(state.entries).toEqual([]);
    expect(warning).toBeNull();
  });

  it('reports a non-ENOENT read failure as a warning rather than throwing', () => {
    const { state, warning } = readAlertState('/x.json', () => {
      throw new Error('EACCES: permission denied');
    });
    expect(state.entries).toEqual([]);
    expect(warning).toContain('EACCES');
  });

  it('survives a truncated file — the ENOSPC case', () => {
    const { state, warning } = readAlertState('/x.json', () => '{"version":1,"entr');
    expect(state.entries).toEqual([]);
    expect(warning).toContain('could not parse');
  });

  it.each([
    ['a JSON scalar', '42'],
    ['null', 'null'],
    ['an array', '[]'],
    ['an object with no entries', '{"version":1}'],
    ['entries that are not an array', '{"version":1,"entries":{}}'],
    ['a future version', '{"version":2,"entries":[{"key":"a","state":"warn","firedAt":"t"}]}'],
  ])('degrades %s to no memory without throwing', (_label, raw) => {
    const { state } = readAlertState('/x.json', () => raw);
    expect(state).toEqual({ version: 1, entries: [] });
  });

  it('drops only the malformed entries and keeps the good ones beside them', () => {
    // One corrupt entry must not discard the others and re-fire every KPI.
    const raw = JSON.stringify({
      version: 1,
      entries: [
        { key: 'local:disk', state: 'warn', firedAt: '2026-08-12T00:00:00.000Z' },
        { key: 'bad:state', state: 'catastrophe', firedAt: '2026-08-12T00:00:00.000Z' },
        { key: 'bad:unknown-was-never-recordable', state: 'unknown', firedAt: 't' },
        { key: '', state: 'ok', firedAt: 't' },
        { state: 'ok', firedAt: 't' },
        { key: 'bad:firedAt', state: 'ok', firedAt: 12345 },
        null,
        'nonsense',
        { key: 'peer:freshness', state: 'error', firedAt: '2026-08-12T00:00:00.000Z' },
      ],
    });
    const { state } = readAlertState('/x.json', () => raw);
    expect(state.entries.map((e) => e.key)).toEqual(['local:disk', 'peer:freshness']);
  });
});

describe('writeAlertState — never throws', () => {
  it('writes to a temp file then renames, so a crash mid-write cannot truncate the record', () => {
    const writes: Array<[string, string]> = [];
    const renames: Array<[string, string]> = [];
    const result = writeAlertState('/data/ops-alert-state.json', VALID, {
      writeFile: (p, data) => writes.push([p, data]),
      rename: (from, to) => renames.push([from, to]),
      mkdir: () => {},
    });

    expect(result).toEqual({ ok: true, warning: null });
    expect(writes[0][0]).toBe('/data/ops-alert-state.json.tmp');
    expect(JSON.parse(writes[0][1])).toEqual(VALID);
    expect(renames).toEqual([['/data/ops-alert-state.json.tmp', '/data/ops-alert-state.json']]);
  });

  it('reports a full disk as a warning instead of taking the check down', () => {
    const result = writeAlertState('/data/ops-alert-state.json', VALID, {
      writeFile: () => {
        throw new Error('ENOSPC: no space left on device');
      },
      rename: () => {},
      mkdir: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.warning).toContain('ENOSPC');
    expect(result.warning).toContain('re-notify next tick');
  });

  it('round-trips through the parser', () => {
    let stored = '';
    writeAlertState('/x.json', VALID, {
      writeFile: (_p, data) => {
        stored = data;
      },
      rename: () => {},
      mkdir: () => {},
    });
    expect(readAlertState('/x.json', () => stored).state).toEqual(VALID);
  });
});
