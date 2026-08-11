import { describe, it, expect } from 'vitest';
import { getHealthProvenance } from './healthProvenance.js';

describe('getHealthProvenance', () => {
  it('returns dev runtime when NODE_ENV is not production', () => {
    const p = getHealthProvenance({});
    expect(p.runtime).toBe('dev');
  });

  it('returns container runtime when NODE_ENV is production', () => {
    const p = getHealthProvenance({ NODE_ENV: 'production' });
    expect(p.runtime).toBe('container');
  });

  it('returns null commit when COMMIT_SHA is unset', () => {
    const p = getHealthProvenance({});
    expect(p.commit).toBeNull();
  });

  it('returns commit SHA when COMMIT_SHA is set', () => {
    const p = getHealthProvenance({ COMMIT_SHA: 'abc1234' });
    expect(p.commit).toBe('abc1234');
  });

  it('returns default db_path when ENERGY_DB_PATH is unset', () => {
    const p = getHealthProvenance({});
    expect(p.db_path).toBe('/data/energy_dashboard.db');
  });

  it('returns ENERGY_DB_PATH when set', () => {
    const p = getHealthProvenance({ ENERGY_DB_PATH: 'C:/Code/able/data/energy_dashboard.db' });
    expect(p.db_path).toBe('C:/Code/able/data/energy_dashboard.db');
  });

  it('container profile: production + commit + container db_path', () => {
    const p = getHealthProvenance({
      NODE_ENV: 'production',
      COMMIT_SHA: 'deadbeef',
      ENERGY_DB_PATH: '/data/energy_dashboard.db',
    });
    expect(p).toEqual({ runtime: 'container', commit: 'deadbeef', db_path: '/data/energy_dashboard.db' });
  });

  it('dev profile: no NODE_ENV, no commit, local path', () => {
    const p = getHealthProvenance({ ENERGY_DB_PATH: 'C:/Code/able/data/energy_dashboard.db' });
    expect(p).toEqual({ runtime: 'dev', commit: null, db_path: 'C:/Code/able/data/energy_dashboard.db' });
  });
});
