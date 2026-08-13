import type { UsageMaintenanceTimer } from './usageMaintenance.js';
import type { UsageMeter } from './usageMeter.js';
import type { UsageAdminStore } from './usageStore.js';

/**
 * The last thing the public process does with billing data before it exits.
 *
 * A separate module, rather than eight lines inline in `publicIndex.ts`, for one
 * reason: **`publicIndex.ts` cannot be imported by a test.** It opens two
 * database handles and binds a port at import time, deliberately. So a shutdown
 * sequence written inline there is a sequence nothing can exercise — and this
 * particular sequence is the one that decides whether a deploy loses a second of
 * billing data or none.
 *
 * That is not a hypothetical. Driving a real server on Windows shows the
 * shutdown path never running at all, because **Windows does not deliver
 * `SIGTERM`**: Node accepts the listener and the process is terminated outright.
 * `SIGINT` is emulated and does arrive; on Linux both do. So on Windows a
 * `taskkill` loses whatever is buffered, exactly as a `SIGKILL` would on Linux —
 * which is the documented lost-write case, under-counting, and acceptable. What
 * is *not* acceptable is being unable to tell whether the sequence itself is
 * right, on the platform where it does run. Hence this file, and
 * `usageShutdown.test.ts`.
 *
 * ## The order, and why each step is where it is
 *
 * 1. **Flush the meter.** Everything buffered becomes durable. This is the step
 *    that turns "up to one flush interval lost on every restart" into "nothing
 *    lost on a clean one", and a deploy is the most frequent way this process
 *    dies.
 * 2. **Stop the maintenance timers**, so nothing starts a pass while the last
 *    one is running.
 * 3. **Run one final pass.** After the flush, not before — the events written in
 *    step 1 are precisely the ones the rollup has never seen, and a pass that
 *    ran first would leave them for the next start. Failure here is logged and
 *    swallowed: those events are already durable, and the watermark means the
 *    next start resumes exactly where this left off. Blocking an exit on it
 *    would trade a real outage for a tidiness nobody is waiting on.
 * 4. **Close the store.**
 *
 * Synchronous throughout, because `better-sqlite3` is and because an `await`
 * here is a promise the process may exit before settling — which would lose the
 * very events this exists to save.
 */

export interface UsageShutdownOptions {
  meter: UsageMeter;
  maintenance: UsageMaintenanceTimer;
  store: UsageAdminStore;
  log?: (line: string) => void;
  onError?: (step: string, err: unknown) => void;
}

export function shutDownUsage({
  meter,
  maintenance,
  store,
  log = (line) => console.log(line),
  onError = (step, err) => console.error(`Usage shutdown: ${step} failed:`, err),
}: UsageShutdownOptions): void {
  // Each step is guarded separately rather than the whole sequence being wrapped
  // in one `try`. A store that throws on the final maintenance pass must still
  // get closed, and a meter that throws on flush must not prevent the pass that
  // aggregates whatever *did* get written.
  try {
    meter.flush();
    meter.close();
  } catch (err) {
    onError('flush', err);
  }

  try {
    maintenance.stop();
  } catch (err) {
    onError('stopping the maintenance timers', err);
  }

  try {
    const outcome = maintenance.runNow();
    if (outcome.rollUp.events > 0) {
      log(`Usage: rolled up ${outcome.rollUp.events} final events before exit.`);
    }
  } catch (err) {
    // Not fatal, and worth saying why in the message: somebody reading this line
    // in a deploy log should not go looking for lost billing data.
    onError('the final maintenance pass (events are already durable)', err);
  }

  try {
    store.close();
  } catch (err) {
    onError('closing the usage store', err);
  }
}
