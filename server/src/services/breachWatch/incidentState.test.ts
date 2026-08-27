import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EMPTY_INCIDENT_STATE,
  findIncident,
  parseIncidentState,
  pruneLapsed,
  readIncidentState,
  resolveIncidentStatePath,
  upsertIncident,
  writeIncidentState,
  type IncidentRecord,
} from './incidentState.js';

/**
 * The memory that makes the watcher idempotent.
 *
 * The behaviour worth pinning is the *degradation*: this file lives on a host we
 * do not control, and a monitoring job that dies on its own state file is worse
 * than one that forgets. Every malformed input below has to produce "no memory"
 * and no throw.
 */

function record(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    key: 's4:key_live_001',
    issueId: 'issue-1',
    openedAt: '2026-08-27T00:00:00.000Z',
    windowEndsAt: '2026-08-28T00:00:00.000Z',
    lastNotifiedAt: '2026-08-27T00:00:00.000Z',
    magnitude: 15,
    ...overrides,
  };
}

describe('resolveIncidentStatePath', () => {
  it('sits beside the energy database, not beside the key store', () => {
    // api_keys.db is the entire reportable surface (ABL-524 §0) and Tier 2 will
    // watch who touches it. A scheduler rewriting a JSON file in that directory
    // every few minutes would put noise directly on top of that signal.
    const resolved = resolveIncidentStatePath({ ENERGY_DB_PATH: '/data/energy_dashboard.db' });
    expect(resolved).toBe(path.join('/data', 'breach-watch-state.json'));
  });

  it('is overridable', () => {
    expect(resolveIncidentStatePath({ BREACH_WATCH_STATE_PATH: '/tmp/x.json' })).toBe('/tmp/x.json');
  });
});

describe('parseIncidentState degrades rather than throwing', () => {
  it('rejects a foreign version', () => {
    expect(parseIncidentState('{"version":2,"incidents":[]}')).toEqual(EMPTY_INCIDENT_STATE);
  });

  it('rejects a non-object', () => {
    expect(parseIncidentState('"nope"')).toEqual(EMPTY_INCIDENT_STATE);
  });

  it('drops only the malformed record, keeping the good one beside it', () => {
    // One corrupt entry must not discard the others and re-open every incident.
    const raw = JSON.stringify({
      version: 1,
      incidents: [record(), { key: 'broken' }, record({ key: 's2:key_live_002' })],
    });
    expect(parseIncidentState(raw).incidents.map((r) => r.key)).toEqual([
      's4:key_live_001',
      's2:key_live_002',
    ]);
  });
});

describe('readIncidentState / writeIncidentState', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breach-watch-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('treats an absent file as first boot, with no warning', () => {
    const result = readIncidentState(path.join(dir, 'missing.json'));
    expect(result.state).toEqual(EMPTY_INCIDENT_STATE);
    expect(result.warning).toBeNull();
  });

  it('warns but does not throw on a truncated file', () => {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{"version":1,"incid');
    const result = readIncidentState(file);
    expect(result.state).toEqual(EMPTY_INCIDENT_STATE);
    expect(result.warning).toContain('not valid JSON');
  });

  it('round-trips', () => {
    const file = path.join(dir, 'state.json');
    const state = { version: 1 as const, incidents: [record()] };
    expect(writeIncidentState(file, state).warning).toBeNull();
    expect(readIncidentState(file).state).toEqual(state);
  });

  it('creates the directory rather than failing when it is absent', () => {
    const file = path.join(dir, 'nested', 'state.json');
    expect(writeIncidentState(file, { version: 1, incidents: [] }).warning).toBeNull();
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('window lapse and lookup', () => {
  it('keeps an incident inside its window and drops it after', () => {
    const state = { version: 1 as const, incidents: [record()] };
    expect(pruneLapsed(state, new Date('2026-08-27T12:00:00.000Z')).incidents).toHaveLength(1);
    expect(pruneLapsed(state, new Date('2026-08-28T00:00:01.000Z')).incidents).toHaveLength(0);
  });

  it('finds by key and replaces in place rather than appending a duplicate', () => {
    let state = upsertIncident(EMPTY_INCIDENT_STATE, record());
    state = upsertIncident(state, record({ magnitude: 900 }));
    expect(state.incidents).toHaveLength(1);
    expect(findIncident(state, 's4:key_live_001')?.magnitude).toBe(900);
  });
});
