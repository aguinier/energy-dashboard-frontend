import type { RetentionOutcome, UsageAdminStore } from './usageStore.js';

/**
 * The scheduled half of metering: aggregate, close, and forget.
 *
 * ABL-297 §9(2) requires the monthly aggregate to be a materialised record with
 * its own lifecycle, and §9(2) item 2 requires retention to be **"a scheduled
 * job, not a policy"** — in those words, because "a retention period nobody
 * implements is worse than none, since it is a published statement we are
 * demonstrably not meeting". This module is the job. `usageCli.ts` runs the same
 * function one-shot, so an operator can do by hand exactly what the timer does,
 * and `publicIndex.ts` starts the timer so it happens whether or not anyone
 * remembers to.
 *
 * ## The order is the correctness argument
 *
 * `rollUp` → `closeMonths` → `applyRetention`, always, and each step depends on
 * the one before it having run:
 *
 * 1. **Roll up first.** Every later step is gated on the rollup watermark. An
 *    event that has not been aggregated is an event that is not on any invoice.
 * 2. **Close second.** A month may only be closed once its events are in the
 *    rollup; `closeMonths` refuses otherwise and reports the month as deferred.
 * 3. **Retention last.** It deletes only rows at or below the watermark, so a
 *    broken rollup makes retention keep rows rather than destroy un-invoiced
 *    ones.
 *
 * Each step is independently safe — `closeMonths` checks for pending events
 * itself rather than trusting that step 1 ran, and `applyRetention` re-reads
 * the watermark rather than trusting either. The order is what makes the pass
 * *useful*; the guards inside each step are what make a pass in the wrong order,
 * or a pass that was interrupted halfway, still *correct*.
 *
 * ## Scope, which is narrower than it looks
 *
 * The only table anything here deletes from is `usage_events`. ABL-297 §9(5)
 * records that this issue introduces the first scheduled deletion in the
 * codebase and is therefore where the forecast-vintage retention commitment
 * (ToS §9.3) is most likely to be broken by accident later: **forecast vintages
 * must never be pruned for storage reasons.** There is no general-purpose row
 * reaper here and there should never be one. `usage_rollup` is likewise never
 * deleted from — those rows are the seven-year invoice record and outlive the
 * events they were computed from, which is the entire reason they exist.
 */

export interface RollUpSummary {
  /** How many `rollUp` calls this pass made. */
  passes: number;
  /** Events aggregated across those passes. */
  events: number;
  /** Rollup rows created or updated. */
  rows: number;
  /** The watermark afterwards. */
  rolledThroughEventId: number;
  /**
   * False when {@link MAX_ROLLUP_PASSES} stopped the pass with work left.
   *
   * Not an error — the next tick resumes from the watermark — but it is
   * reported rather than swallowed, because a pass that is *permanently*
   * undrained means the backlog is growing faster than the rollup clears it,
   * and that is the condition under which retention starts keeping rows and a
   * month stops being closable.
   */
  drained: boolean;
}

export interface UsageMaintenanceOutcome {
  rollUp: RollUpSummary;
  closed: string[];
  deferred: string[];
  retention: RetentionOutcome;
}

/**
 * How many rollup batches one pass will run before yielding.
 *
 * At `ROLLUP_BATCH_EVENTS` = 50 000 each, this is 1 000 000 events in a pass,
 * which is far more than a LAN deployment produces in a day and still a bound
 * rather than a loop that runs until it happens to finish. The bound exists so
 * a pass cannot hold the write lock for an unbounded time on a store the
 * request path is also writing to.
 */
export const MAX_ROLLUP_PASSES = 20;

/**
 * Aggregate everything outstanding, close what is due, apply retention.
 *
 * Synchronous throughout, because `better-sqlite3` is, and because the shutdown
 * path and the CLI both want to know it finished rather than that it started.
 */
export function runUsageMaintenance(
  store: UsageAdminStore,
  now: Date = new Date()
): UsageMaintenanceOutcome {
  const rollUp = drainRollUp(store);
  const { closed, deferred } = store.closeMonths(now);
  const retention = store.applyRetention(now);

  return { rollUp, closed, deferred, retention };
}

/** Roll up repeatedly until nothing is left, or until the pass cap is reached. */
export function drainRollUp(store: UsageAdminStore): RollUpSummary {
  const summary: RollUpSummary = {
    passes: 0,
    events: 0,
    rows: 0,
    rolledThroughEventId: 0,
    drained: true,
  };

  for (let pass = 0; pass < MAX_ROLLUP_PASSES; pass += 1) {
    const outcome = store.rollUp();
    summary.passes += 1;
    summary.events += outcome.events;
    summary.rows += outcome.rows;
    summary.rolledThroughEventId = outcome.rolledThroughEventId;
    if (!outcome.moreRemaining) return summary;
  }

  summary.drained = false;
  return summary;
}

/**
 * How often the rollup runs.
 *
 * A minute, so `usage:month` for the month in progress is never more than a
 * minute stale and a customer asking "what have I used today" gets an answer
 * from the materialised table rather than from a scan of raw events. The pass
 * is a single indexed range read over rows added since the watermark, so at a
 * LAN traffic level it is usually a no-op that costs one `SELECT MAX(id)`.
 */
export const DEFAULT_ROLLUP_INTERVAL_MS = 60_000;

/**
 * How often months are closed and retention applied.
 *
 * Six hours rather than daily. Both boundaries are expressed in days, so the
 * interval only decides how long after a row crosses one it is acted on; six
 * hours makes "we delete IP addresses at 90 days" true to within a quarter of a
 * day, which is a margin worth having on a sentence a subscriber is shown.
 * Cheaper than it sounds: each pass is two indexed range statements, and after
 * the first they match nothing until the next boundary is crossed.
 */
export const DEFAULT_FULL_PASS_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UsageMaintenanceOptions {
  store: UsageAdminStore;
  rollUpIntervalMs?: number;
  fullPassIntervalMs?: number;
  now?: () => Date;
  /** Injectable so a test can read what was reported without capturing console. */
  log?: (line: string) => void;
  onError?: (step: string, err: unknown) => void;
}

export interface UsageMaintenanceTimer {
  /** Run a full pass now, off the schedule. The shutdown path and the CLI use this. */
  runNow(): UsageMaintenanceOutcome;
  stop(): void;
}

/**
 * Start the timers.
 *
 * Two intervals rather than one, because the two jobs have genuinely different
 * periods — see the constants above — and folding them into one timer with a
 * counter would hide that. Both are `unref`'d: a metering timer that kept a
 * terminating process alive would be a worse bug than any it prevents, and the
 * shutdown path calls {@link UsageMaintenanceTimer.runNow} explicitly.
 *
 * Every step is wrapped. A store that throws must not take down the API it is
 * metering — the events stay in `usage_events` either way, the watermark is
 * unchanged, and the next tick retries from exactly where this one failed.
 * Failing loudly in the log and continuing to serve is the right trade here;
 * failing loudly and stopping would turn a rollup bug into an outage.
 */
export function startUsageMaintenance({
  store,
  rollUpIntervalMs = DEFAULT_ROLLUP_INTERVAL_MS,
  fullPassIntervalMs = DEFAULT_FULL_PASS_INTERVAL_MS,
  now = () => new Date(),
  log = (line) => console.log(line),
  onError = (step, err) => console.error(`Usage maintenance: ${step} failed:`, err),
}: UsageMaintenanceOptions): UsageMaintenanceTimer {
  function guard<T>(step: string, run: () => T): T | undefined {
    try {
      return run();
    } catch (err) {
      onError(step, err);
      return undefined;
    }
  }

  const rollUpTimer = setInterval(() => {
    const summary = guard('roll-up', () => drainRollUp(store));
    if (summary && !summary.drained) {
      log(
        `Usage maintenance: rollup did not drain in ${summary.passes} passes ` +
          `(watermark ${summary.rolledThroughEventId}). The backlog is growing faster than it ` +
          'clears; months cannot close and retention will keep rows until it catches up.'
      );
    }
  }, rollUpIntervalMs).unref();

  const fullPassTimer = setInterval(() => {
    guard('full pass', () => {
      const outcome = runUsageMaintenance(store, now());
      reportFullPass(outcome, log);
      return outcome;
    });
  }, fullPassIntervalMs).unref();

  return {
    runNow: () => runUsageMaintenance(store, now()),
    stop() {
      clearInterval(rollUpTimer);
      clearInterval(fullPassTimer);
    },
  };
}

/**
 * Say what happened, but only when something did.
 *
 * A daily line saying "closed nothing, deleted nothing" trains whoever reads
 * these logs to skip them, which is precisely the wrong habit for the one job
 * that deletes rows. The exception is `keptPendingRollup`, which is logged
 * whenever it is non-zero even though it means *no* deletion happened: it says
 * the rollup has been broken for longer than the retention window, and the
 * correct response is to fix the rollup rather than to delete the evidence.
 */
export function reportFullPass(
  outcome: UsageMaintenanceOutcome,
  log: (line: string) => void
): void {
  if (outcome.closed.length > 0) {
    log(`Usage maintenance: closed ${outcome.closed.join(', ')} — those months are now final.`);
  }
  if (outcome.deferred.length > 0) {
    log(
      `Usage maintenance: deferred closing ${outcome.deferred.join(', ')} — events for those ` +
        'months are not aggregated yet. They will close on a later pass.'
    );
  }
  if (outcome.retention.scrubbed > 0 || outcome.retention.deleted > 0) {
    log(
      `Usage maintenance: scrubbed IP and user agent from ${outcome.retention.scrubbed} request ` +
        `records, deleted ${outcome.retention.deleted} de-identified records (ABL-297 §5).`
    );
  }
  if (outcome.retention.keptPendingRollup > 0) {
    log(
      `Usage maintenance: KEPT ${outcome.retention.keptPendingRollup} request records past the ` +
        'deletion boundary because they are not in the rollup yet. This is a rollup failure, not ' +
        'a retention failure — deleting them would remove them from an invoice permanently. ' +
        'Investigate the rollup.'
    );
  }
}
