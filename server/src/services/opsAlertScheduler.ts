import type { CombinedOpsStatus } from './combinedOpsStatusService.js';
import { createLoggingChannel, type AlertChannel } from './opsAlertChannel.js';
import { observeCombinedStatus } from '../lib/opsAlertRules.js';
import { evaluateAlerts, type AlertNotification } from '../lib/opsAlertEngine.js';
import {
  readAlertState,
  writeAlertState,
  resolveAlertStatePath,
} from '../lib/opsAlertStateStore.js';

/**
 * The scheduled check that turns the ops status page into a monitoring tool
 * (ABL-287): read both lanes' KPIs, compare each against what was last
 * reported, and notify on transition.
 *
 * WHY IT CALLS `getCombinedOpsStatus()` RATHER THAN FETCHING THE ENDPOINT
 *
 * The issue describes this as "reads the combined endpoint", and it reads
 * exactly what that endpoint serves — but in-process, since the route is a
 * thin wrapper over this same function (`routes/opsStatus.ts`). Looping back
 * over HTTP to our own port would add a way for the check to fail (bound
 * interface, port in use, proxy in front) that has nothing to do with the
 * health it is reporting on, and would mean a check that cannot run precisely
 * when the server is unwell. The peer lane still goes over HTTP, because that
 * is genuinely a different host.
 *
 * DEFAULT ON
 *
 * Alerting that ships disabled is not monitoring. The only channel is logging
 * (Board decision), so there is no external side effect to opt into, and the
 * cost is one combined-status evaluation every 5 minutes — far below the ~30s
 * poll the deployed `/ops-status` page already drives. `OPS_ALERTS_ENABLED=false`
 * turns it off for a checkout that does not want the log noise.
 */

const DEFAULT_INTERVAL_MINUTES = 5;
const MIN_INTERVAL_MINUTES = 1;

/**
 * Loaded on first use, not at module import. `combinedOpsStatusService.js`
 * reaches `config/database.js`, which opens a real `better-sqlite3` handle as
 * an *import* side effect — so a static import here would mean that merely
 * importing this scheduler (from `index.ts`, or from a test) opens a database
 * connection. `forecastVintageArchiveScheduler.ts:4-8` avoids the same trap for
 * the same reason. Keeping it dynamic is what lets this module's own tests run
 * as pure logic, with no fixture database and no `vi.mock` of the connection.
 */
async function defaultGetStatus(now: Date): Promise<CombinedOpsStatus> {
  const { getCombinedOpsStatus } = await import('./combinedOpsStatusService.js');
  return getCombinedOpsStatus(now);
}

export interface OpsAlertSchedulerDecision {
  enabled: boolean;
  intervalMs: number;
  statePath: string;
  reason: string;
}

/** Pure: opt-out, not opt-in. Anything but an explicit `false`/`0` leaves it on. */
export function shouldScheduleOpsAlerts(env: NodeJS.ProcessEnv): boolean {
  const raw = env.OPS_ALERTS_ENABLED?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0';
}

/**
 * Pure. A garbage or absurdly small `OPS_ALERT_INTERVAL_MINUTES` falls back to
 * the default rather than spinning the check every few milliseconds — a typo in
 * a deployment env must not turn the monitor into the incident.
 */
export function resolveOpsAlertIntervalMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.OPS_ALERT_INTERVAL_MINUTES);
  const minutes =
    Number.isFinite(parsed) && parsed >= MIN_INTERVAL_MINUTES ? parsed : DEFAULT_INTERVAL_MINUTES;
  return minutes * 60 * 1000;
}

/** Pure: the decision plus a human-readable reason, for a single log line at boot. */
export function describeOpsAlertSchedulerStart(
  env: NodeJS.ProcessEnv = process.env,
): OpsAlertSchedulerDecision {
  const enabled = shouldScheduleOpsAlerts(env);
  const intervalMs = resolveOpsAlertIntervalMs(env);
  const statePath = resolveAlertStatePath(env);
  return {
    enabled,
    intervalMs,
    statePath,
    reason: enabled
      ? `checking every ${Math.round(intervalMs / 60000)}m, state at ${statePath}`
      : 'OPS_ALERTS_ENABLED is false',
  };
}

export interface OpsAlertCheckDeps {
  getStatus?: (now: Date) => Promise<CombinedOpsStatus>;
  channel?: AlertChannel;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  logger?: { warn: (m: string) => void; error: (m: string) => void; log: (m: string) => void };
}

export interface OpsAlertCheckResult {
  notifications: AlertNotification[];
  /** True when the blackout window held the DB-backed KPIs this tick. */
  blackoutActive: boolean;
  /** Non-fatal problems worth a log line: unreadable state file, failed persist, failed delivery. */
  warnings: string[];
}

/**
 * One evaluation. Every dependency is injectable so the whole path — status to
 * notification to persisted state — is testable without a database, a socket,
 * or a real file.
 *
 * Nothing in here is allowed to throw. A failure to fetch status, deliver, or
 * persist is collected as a warning; the scheduler keeps ticking.
 */
export async function runOpsAlertCheck(
  deps: OpsAlertCheckDeps = {},
): Promise<OpsAlertCheckResult> {
  const {
    getStatus = defaultGetStatus,
    env = process.env,
    now = new Date(),
    logger = console,
  } = deps;
  const channel = deps.channel ?? createLoggingChannel(logger);
  const warnings: string[] = [];

  let status: CombinedOpsStatus;
  try {
    status = await getStatus(now);
  } catch (err) {
    // getCombinedOpsStatus already degrades a failing side to `reachable: false`
    // rather than throwing, so reaching here means something unexpected. Report
    // it and skip the tick — with no observations there is nothing trustworthy
    // to compare, and overwriting the record from a failed read would lose the
    // memory of what we last said.
    warnings.push(
      `ops alert check could not read combined status: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { notifications: [], blackoutActive: false, warnings };
  }

  const statePath = resolveAlertStatePath(env);
  const { state: previous, warning: readWarning } = readAlertState(statePath);
  if (readWarning) warnings.push(readWarning);

  const blackoutActive = status.syncBlackout.active;
  const { notifications, state } = evaluateAlerts(observeCombinedStatus(status), previous, {
    now,
    blackoutActive,
  });

  if (notifications.length > 0) {
    try {
      await channel.deliver(notifications);
    } catch (err) {
      // Delivery failed, so the humans were NOT told. Do not persist the new
      // states — that would record "already reported" for something nobody
      // received, and the breach would then never be mentioned again. Leaving
      // the old record means the next tick retries.
      warnings.push(
        `ops alert delivery via ${channel.name} failed, not recording these transitions: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      for (const warning of warnings) logger.error(`🚨 ${warning}`);
      return { notifications: [], blackoutActive, warnings };
    }
  }

  const { warning: writeWarning } = writeAlertState(statePath, state);
  if (writeWarning) warnings.push(writeWarning);

  for (const warning of warnings) logger.error(`🚨 ${warning}`);

  return { notifications, blackoutActive, warnings };
}

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * Starts the recurring check. Ticks once immediately so a restart re-establishes
 * the picture without waiting out a full interval, then on the timer. An
 * in-flight guard skips rather than overlaps — the peer fetch has a 5s timeout
 * and the local side touches the database, so two concurrent passes would
 * double that load for no benefit, and could interleave two writes of the state
 * file.
 */
export function startOpsAlertScheduler(
  env: NodeJS.ProcessEnv = process.env,
  deps: OpsAlertCheckDeps = {},
): SchedulerHandle | null {
  const decision = describeOpsAlertSchedulerStart(env);
  console.log(`🚨 Ops alert engine: ${decision.reason}`);
  if (!decision.enabled) return null;

  let running = false;
  const tick = () => {
    if (running) {
      console.log('🚨 Ops alert engine: previous check still running, skipping this tick.');
      return;
    }
    running = true;
    runOpsAlertCheck({ ...deps, env })
      .then((result) => {
        if (result.notifications.length > 0) {
          console.log(`🚨 Ops alert engine: ${result.notifications.length} transition(s) notified.`);
        }
      })
      .catch((error) => {
        // runOpsAlertCheck is written not to reject; this is the belt to that
        // braces, so an unforeseen throw cannot kill the interval.
        console.error('🚨 Ops alert check failed:', error);
      })
      .finally(() => {
        running = false;
      });
  };

  tick();
  const timer = setInterval(tick, decision.intervalMs);
  timer.unref();

  return { stop: () => clearInterval(timer) };
}
