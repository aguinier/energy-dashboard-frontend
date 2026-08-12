import type { UsageEvent, UsageSink, UsageWriteOutcome } from './usageStore.js';

/**
 * A {@link UsageSink} backed by an array. **Tests only.**
 *
 * It exists for the same reason `memoryApiKeyDirectory.ts` does: the meter has
 * branches — a sink that throws, a buffer at its ceiling, a flush retried after
 * a failure — that are awkward to reach through a real database and trivial to
 * reach through a fake. What the fake cannot say anything true about is SQLite,
 * so every claim that is *about* the store — that `INSERT OR IGNORE` makes a
 * replayed batch a no-op, that `AUTOINCREMENT` keeps the watermark monotonic,
 * that retention deletes what it says — is tested against the real file in
 * `sqliteUsageStore.test.ts`.
 *
 * It deduplicates on `requestId`, because that is the property of a real sink
 * the meter's callers are entitled to rely on, and a fake that silently
 * double-counted would make the meter's own idempotency tests pass for the
 * wrong reason.
 *
 * Not a deployment target: `publicAppGraph.test.ts` asserts by name that the
 * serving entrypoint cannot reach this module.
 */

export interface MemoryUsageSink extends UsageSink {
  /** Everything written, in write order. */
  events: UsageEvent[];
  /** Fail the next `writeEvents` call, once, to exercise the retry path. */
  failNext(message?: string): void;
  /** Fail every call until cleared, to exercise the buffer ceiling. */
  failAlways(fail: boolean): void;
  byKey(keyId: string): UsageEvent[];
  billable(): UsageEvent[];
}

export function createMemoryUsageSink(): MemoryUsageSink {
  const events: UsageEvent[] = [];
  const seen = new Set<string>();
  let failOnce: string | null = null;
  let failEvery = false;

  return {
    events,

    writeEvents(batch): UsageWriteOutcome {
      if (failEvery) throw new Error('memory sink: failing every write');
      if (failOnce !== null) {
        const message = failOnce;
        failOnce = null;
        throw new Error(message);
      }

      let inserted = 0;
      let alreadyPresent = 0;
      for (const event of batch) {
        if (seen.has(event.requestId)) {
          alreadyPresent += 1;
          continue;
        }
        seen.add(event.requestId);
        events.push(event);
        inserted += 1;
      }
      return { inserted, alreadyPresent, suppressedAsDuplicate: 0 };
    },

    failNext(message = 'memory sink: injected failure') {
      failOnce = message;
    },
    failAlways(fail) {
      failEvery = fail;
    },
    byKey(keyId) {
      return events.filter((event) => event.keyId === keyId);
    },
    billable() {
      return events.filter((event) => event.billable);
    },
  };
}
