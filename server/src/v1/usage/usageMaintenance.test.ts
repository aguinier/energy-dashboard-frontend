import { describe, it, expect, vi } from 'vitest';
import {
  drainRollUp,
  MAX_ROLLUP_PASSES,
  reportFullPass,
  runUsageMaintenance,
  startUsageMaintenance,
  type UsageMaintenanceOutcome,
} from './usageMaintenance.js';
import type {
  CloseMonthsOutcome,
  RetentionOutcome,
  RollUpOutcome,
  UsageAdminStore,
} from './usageStore.js';

/**
 * The scheduled pass, tested against a recording stub rather than a database.
 *
 * What is under test here is *order and reporting*, not aggregation — the
 * aggregation is `sqliteUsageStore.test.ts`'s, against a real file. The reason
 * order deserves its own file is that each step is independently safe but only
 * useful in one sequence, and a refactor that reorders them would still pass
 * every test in the store suite.
 */

interface StubOptions {
  rollUpPasses?: number;
  closed?: string[];
  deferred?: string[];
  retention?: Partial<RetentionOutcome>;
}

function stubStore({
  rollUpPasses = 1,
  closed = [],
  deferred = [],
  retention = {},
}: StubOptions = {}): UsageAdminStore & { calls: string[] } {
  const calls: string[] = [];
  let pass = 0;

  return {
    calls,
    writeEvents: () => ({ inserted: 0, alreadyPresent: 0, suppressedAsDuplicate: 0 }),
    rollUp(): RollUpOutcome {
      pass += 1;
      calls.push(`rollUp:${pass}`);
      return {
        events: 10,
        rows: 1,
        rolledThroughEventId: pass * 10,
        moreRemaining: pass < rollUpPasses,
      };
    },
    closeMonths(): CloseMonthsOutcome {
      calls.push('closeMonths');
      return { closed, deferred };
    },
    applyRetention(): RetentionOutcome {
      calls.push('applyRetention');
      return { scrubbed: 0, deleted: 0, keptPendingRollup: 0, ...retention };
    },
    monthlyUsage: () => [],
    // ABL-302's live quota read. Present because the interface has it, and
    // deliberately absent from `calls`: it is the request path's method, and a
    // maintenance pass that touched it would be reaching across the split the
    // two sit either side of.
    servedRequestsInMonth: () => 0,
    exportAccount: () => ({ exportedAt: '', accountId: '', keys: [], events: [], rollups: [] }),
    stats: () => {
      throw new Error('not used here');
    },
    close: () => calls.push('close'),
  };
}

describe('the order of a maintenance pass is the correctness argument', () => {
  it('rolls up, then closes, then applies retention', () => {
    const store = stubStore();

    runUsageMaintenance(store, new Date('2026-08-15T00:00:00Z'));

    // Every later step is gated on the rollup watermark: a month cannot close
    // over un-aggregated events, and retention will not delete below the
    // watermark. Running them in any other order does not corrupt anything —
    // each step guards itself — but it does make the pass useless, which no
    // assertion in the store suite would catch.
    expect(store.calls).toEqual(['rollUp:1', 'closeMonths', 'applyRetention']);
  });

  it('drains the rollup fully before closing anything', () => {
    const store = stubStore({ rollUpPasses: 3 });

    const outcome = runUsageMaintenance(store, new Date('2026-08-15T00:00:00Z'));

    expect(store.calls).toEqual(['rollUp:1', 'rollUp:2', 'rollUp:3', 'closeMonths', 'applyRetention']);
    expect(outcome.rollUp.passes).toBe(3);
    expect(outcome.rollUp.events).toBe(30);
    expect(outcome.rollUp.drained).toBe(true);
  });

  it('stops at the pass cap and says so rather than looping until it happens to finish', () => {
    // The bound exists so a pass cannot hold the write lock for an unbounded
    // time on a store the request path is also writing to.
    const store = stubStore({ rollUpPasses: MAX_ROLLUP_PASSES + 5 });

    const summary = drainRollUp(store);

    expect(summary.passes).toBe(MAX_ROLLUP_PASSES);
    expect(summary.drained).toBe(false);
  });
});

describe('what a pass reports', () => {
  function report(outcome: Partial<UsageMaintenanceOutcome>): string[] {
    const lines: string[] = [];
    reportFullPass(
      {
        rollUp: { passes: 1, events: 0, rows: 0, rolledThroughEventId: 0, drained: true },
        closed: [],
        deferred: [],
        retention: { scrubbed: 0, deleted: 0, keptPendingRollup: 0 },
        ...outcome,
      },
      (line) => lines.push(line)
    );
    return lines;
  }

  it('says nothing when nothing happened', () => {
    // A daily line saying "closed nothing, deleted nothing" trains whoever reads
    // these logs to skip them, which is the wrong habit for the one job that
    // deletes rows.
    expect(report({})).toEqual([]);
  });

  it('names the months it closed, because closing is irreversible', () => {
    expect(report({ closed: ['2026-06', '2026-07'] })[0]).toContain('2026-06, 2026-07');
  });

  it('names a deferred month and what to do about it', () => {
    expect(report({ deferred: ['2026-07'] })[0]).toMatch(/not aggregated yet/);
  });

  it('reports what retention removed', () => {
    const lines = report({ retention: { scrubbed: 12, deleted: 3, keptPendingRollup: 0 } });
    expect(lines[0]).toContain('12');
    expect(lines[0]).toContain('3');
  });

  it('shouts when rows were KEPT past the deletion boundary', () => {
    // The one case logged even though nothing happened: it means the rollup has
    // been broken for longer than the retention window, and the correct
    // response is to fix the rollup rather than delete the evidence.
    const lines = report({ retention: { scrubbed: 0, deleted: 0, keptPendingRollup: 7 } });
    expect(lines[0]).toContain('KEPT 7');
    expect(lines[0]).toMatch(/rollup failure, not a retention failure/);
  });
});

describe('the timer', () => {
  it('does not let a failing store take the API down with it', () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const exploding: UsageAdminStore = {
      ...stubStore(),
      rollUp() {
        throw new Error('database is locked');
      },
    };

    const timer = startUsageMaintenance({
      store: exploding,
      rollUpIntervalMs: 1_000,
      onError: (step) => errors.push(step),
      log: () => {},
    });

    try {
      expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();
      // The events stay in `usage_events`, the watermark is unchanged, and the
      // next tick retries from exactly where this one failed. Failing loudly and
      // continuing to serve beats turning a rollup bug into an outage.
      expect(errors).toEqual(['roll-up', 'roll-up', 'roll-up']);
    } finally {
      timer.stop();
      vi.useRealTimers();
    }
  });

  it('runs the full pass on its own, slower interval', () => {
    vi.useFakeTimers();
    const store = stubStore();
    const timer = startUsageMaintenance({
      store,
      rollUpIntervalMs: 1_000,
      fullPassIntervalMs: 10_000,
      log: () => {},
    });

    try {
      vi.advanceTimersByTime(9_000);
      expect(store.calls.filter((c) => c === 'closeMonths')).toHaveLength(0);

      vi.advanceTimersByTime(2_000);
      expect(store.calls.filter((c) => c === 'closeMonths')).toHaveLength(1);
      expect(store.calls.filter((c) => c === 'applyRetention')).toHaveLength(1);
    } finally {
      timer.stop();
      vi.useRealTimers();
    }
  });

  it('warns when the rollup cannot keep up', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const store = stubStore({ rollUpPasses: MAX_ROLLUP_PASSES + 1 });
    const timer = startUsageMaintenance({
      store,
      rollUpIntervalMs: 1_000,
      fullPassIntervalMs: 1_000_000,
      log: (line) => lines.push(line),
    });

    try {
      vi.advanceTimersByTime(1_000);
      expect(lines[0]).toMatch(/did not drain/);
      expect(lines[0]).toMatch(/months cannot close/);
    } finally {
      timer.stop();
      vi.useRealTimers();
    }
  });

  it('stops both timers, so a closed store is never touched again', () => {
    vi.useFakeTimers();
    const store = stubStore();
    const timer = startUsageMaintenance({
      store,
      rollUpIntervalMs: 1_000,
      fullPassIntervalMs: 1_000,
      log: () => {},
    });

    vi.advanceTimersByTime(1_000);
    const after = store.calls.length;
    timer.stop();
    vi.advanceTimersByTime(60_000);

    expect(store.calls).toHaveLength(after);
    vi.useRealTimers();
  });

  it('runs a pass on demand, which is what the shutdown path uses', () => {
    vi.useFakeTimers();
    const store = stubStore();
    const timer = startUsageMaintenance({ store, log: () => {} });

    try {
      timer.runNow();
      expect(store.calls).toEqual(['rollUp:1', 'closeMonths', 'applyRetention']);
    } finally {
      timer.stop();
      vi.useRealTimers();
    }
  });
});
