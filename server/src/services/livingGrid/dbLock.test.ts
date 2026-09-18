import { describe, it, expect } from 'vitest';
import { isDatabaseLocked } from './dbLock.js';

describe('isDatabaseLocked', () => {
  it('recognises an ordinary busy lock', () => {
    expect(isDatabaseLocked({ code: 'SQLITE_BUSY' })).toBe(true);
  });

  it('recognises the readonly-rollback a container reader sees instead', () => {
    // Same event, different vantage point: a reader inside a bind mount cannot
    // see the host writer's lock, so it reads the journal as hot and tries to
    // roll it back on a readonly handle (ABL-657). Treating only SQLITE_BUSY
    // as "busy" would answer 500 for exactly the deployment that hits this.
    expect(isDatabaseLocked({ code: 'SQLITE_READONLY_ROLLBACK' })).toBe(true);
  });

  it('does not mistake a real query fault for a lock', () => {
    // A retry-and-wait answer would hide a genuine bug behind a schedule.
    expect(isDatabaseLocked({ code: 'SQLITE_ERROR' })).toBe(false);
    expect(isDatabaseLocked(new Error('no such column: nope'))).toBe(false);
  });

  it('survives anything else being thrown at it', () => {
    for (const value of [null, undefined, 'SQLITE_BUSY', 42, {}]) {
      expect(isDatabaseLocked(value)).toBe(false);
    }
  });
});
