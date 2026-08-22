import { createAuthFailureRecorder, type AuthFailureRecorder } from './authFailureRecorder.js';
import type {
  AuthFailureEvent,
  AuthFailureSink,
  AuthFailureWriteOutcome,
} from './authFailureStore.js';

/**
 * An {@link AuthFailureSink} backed by an array. **Tests only.**
 *
 * The same fake `memoryUsageSink.ts` is, for the same reason: the recorder has
 * branches — a sink that throws, a buffer at its ceiling, a flush retried after
 * a failure — that are awkward to reach through a real database and trivial to
 * reach through an array. What it cannot say anything true about is SQLite, so
 * every claim that is *about* the store — that the schema refuses to hold a
 * secret, that retention scrubs this table on the same boundary as
 * `usage_events`, that the S3/S4 groupings return what they say — is tested
 * against a real file in `sqliteUsageStore.test.ts`.
 *
 * It deduplicates on `eventId`, because that is the property of a real sink the
 * recorder's callers are entitled to rely on: a fake that silently duplicated a
 * retried batch would make the recorder's own idempotency test pass for the
 * wrong reason.
 *
 * Not a deployment target: `publicAppGraph.test.ts` asserts by name that the
 * serving entrypoint cannot reach this module.
 */
export interface MemoryAuthFailureSink extends AuthFailureSink {
  /** Everything written, in write order. */
  events: AuthFailureEvent[];
  /** How many times `writeAuthFailures` has been called at all — including with an empty batch. */
  writeCalls: number;
  /** Fail the next call, once, to exercise the retry path. */
  failNext(message?: string): void;
  /** Fail every call until cleared, to exercise the buffer ceiling. */
  failAlways(fail: boolean): void;
  byCode(errorCode: string): AuthFailureEvent[];
}

export function createMemoryAuthFailureSink(): MemoryAuthFailureSink {
  const events: AuthFailureEvent[] = [];
  const seen = new Set<string>();
  let failOnce: string | null = null;
  let failEvery = false;

  const sink: MemoryAuthFailureSink = {
    events,
    writeCalls: 0,

    writeAuthFailures(batch): AuthFailureWriteOutcome {
      sink.writeCalls += 1;
      if (failEvery) throw new Error('memory auth-failure sink: failing every write');
      if (failOnce !== null) {
        const message = failOnce;
        failOnce = null;
        throw new Error(message);
      }

      let inserted = 0;
      let alreadyPresent = 0;
      for (const event of batch) {
        if (seen.has(event.eventId)) {
          alreadyPresent += 1;
          continue;
        }
        seen.add(event.eventId);
        events.push(event);
        inserted += 1;
      }
      return { inserted, alreadyPresent };
    },

    failNext(message = 'memory auth-failure sink: injected failure') {
      failOnce = message;
    },
    failAlways(fail) {
      failEvery = fail;
    },
    byCode(errorCode) {
      return events.filter((event) => event.errorCode === errorCode);
    },
  };

  return sink;
}

/**
 * A recorder over a memory sink, with no timer. **Tests only.**
 *
 * `requireApiKey` requires a recorder with no default, so every test that mounts
 * the gate needs one — including the several for which auth failures are
 * incidental scaffolding (the quota gate, the meter, the OpenAPI drift check).
 * This is the one line they all want, and having it in one place is what stops
 * "a recorder that does nothing" being reinvented per file as a `{ record() {} }`
 * stub, which would quietly make those tests pass while proving the gate still
 * *calls* it nowhere.
 *
 * `flushIntervalMs: 0` disables the timer, so flushing is something a test does
 * rather than something it waits for.
 */
export function createTestAuthFailureRecorder(): {
  recorder: AuthFailureRecorder;
  sink: MemoryAuthFailureSink;
} {
  const sink = createMemoryAuthFailureSink();
  return {
    sink,
    recorder: createAuthFailureRecorder({
      sink,
      flushIntervalMs: 0,
      // Silent by default: a suite that drove a failing sink on purpose would
      // otherwise print its own injected errors, which trains a reader to skip
      // the output of the file that watches for attacks.
      onError: () => {},
    }),
  };
}
