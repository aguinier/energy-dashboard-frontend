import {
  createLoggingIncidentChannel,
  createPaperclipIncidentChannel,
  resolvePaperclipConfig,
  type IncidentChannel,
} from './breachWatch/incidentChannel.js';
import { buildIncident, buildUpdateComment, type IncidentContext } from './breachWatch/incidentReport.js';
import { detectBreachSignals, PROVISIONAL_MIN_PREFIXES_PER_ORIGIN, type BreachFinding } from './breachWatch/signals.js';
import {
  findIncident,
  pruneLapsed,
  readIncidentState,
  resolveIncidentStatePath,
  upsertIncident,
  writeIncidentState,
  type IncidentRecord,
  type IncidentState,
} from './breachWatch/incidentState.js';
import type { AuthFailureAdminStore, AuthFailureWindow } from '../v1/security/authFailureStore.js';

/**
 * The scheduled check that turns ABL-530's tables into an alarm (ABL-578).
 *
 * ABL-530 recorded `/v1` authentication failures and gave an investigator four
 * `security:*` commands to read them with. Nothing ran on its own, so a credential
 * attack would have been fully visible in storage and seen by nobody — detection
 * specified and recorded but not alarmed, which reads as coverage and is not.
 * This module is the part that looks without being asked.
 *
 * Deliberately the same shape as `opsAlertScheduler.ts`, because ABL-578 says to
 * run this wherever the existing scheduled work runs and not to introduce a new
 * scheduling mechanism: pure decision functions, one injectable `run…Check`, a
 * `setInterval` with an in-flight guard, and nothing in the check allowed to
 * throw. Why it runs in **this** process rather than the public one is the long
 * comment at the top of `breachWatch/authFailureReader.ts`; it is the one
 * genuinely load-bearing choice here.
 *
 * ## Idempotency, which is a requirement and not an optimisation
 *
 * ABL-578: *"one open incident per window, updated, not duplicated."* A watcher
 * that opens a `priority: high` issue every tick during a sustained attack turns
 * the alarm into noise and costs real tokens. Three things enforce it:
 *
 * 1. `BreachFinding.incidentKey` is stable per subject and contains **no count**,
 *    so the same attack maps to the same key every tick.
 * 2. `breachWatch/incidentState.ts` remembers which keys have an open incident and
 *    when that stops counting.
 * 3. An update is posted only when the count has **grown** *and* the update
 *    interval has elapsed — so a live-but-unchanged incident is silent, and a
 *    growing one is one thread with a rising number rather than twenty issues.
 * 4. The remembered incident is confirmed **still open** before it suppresses
 *    anything ({@link stillOpen}). Suppression that outlives the thread it points
 *    at is not idempotency, it is a second attack landing on a closed issue.
 *
 * ## Default on
 *
 * Alerting that ships disabled is not monitoring. The cost of a tick against a
 * store with no rows is three indexed group-bys on a small SQLite file, and the
 * common case in a checkout is that `API_KEYS_DB_PATH` is unset, where the reader
 * reports "nothing to watch" and the tick does nothing at all.
 * `BREACH_WATCH_ENABLED=false` turns it off.
 */

const DEFAULT_INTERVAL_MINUTES = 15;
const MIN_INTERVAL_MINUTES = 1;

/** Matches `security:auth-failures --hours 24`, so an alarm and a hand-run report agree. */
const DEFAULT_WINDOW_HOURS = 24;
/** Matches `security:key-origins --days 30`; bounded above by the 90-day scrub. */
const DEFAULT_ORIGIN_LOOKBACK_DAYS = 30;
/** How long one incident suppresses duplicates for the same subject. */
const DEFAULT_INCIDENT_WINDOW_HOURS = 24;
/** Minimum gap between "still firing" comments on one open incident. */
const DEFAULT_UPDATE_INTERVAL_HOURS = 6;

function positiveNumber(raw: string | undefined, fallback: number, minimum = 0): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= minimum && parsed > 0 ? parsed : fallback;
}

/** Pure: opt-out, not opt-in. Anything but an explicit `false`/`0` leaves it on. */
export function shouldScheduleBreachWatch(env: NodeJS.ProcessEnv): boolean {
  const raw = env.BREACH_WATCH_ENABLED?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0';
}

/**
 * Pure. A garbage or absurdly small interval falls back to the default rather
 * than spinning the check every few milliseconds — a typo in a deployment env
 * must not turn the monitor into the incident.
 */
export function resolveBreachWatchIntervalMs(env: NodeJS.ProcessEnv): number {
  return positiveNumber(env.BREACH_WATCH_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES) * 60_000;
}

export interface BreachWatchSettings {
  windowHours: number;
  originLookbackDays: number;
  incidentWindowHours: number;
  updateIntervalHours: number;
  minPrefixesPerOrigin: number;
}

export function resolveBreachWatchSettings(env: NodeJS.ProcessEnv): BreachWatchSettings {
  return {
    windowHours: positiveNumber(env.BREACH_WATCH_WINDOW_HOURS, DEFAULT_WINDOW_HOURS),
    originLookbackDays: positiveNumber(
      env.BREACH_WATCH_ORIGIN_LOOKBACK_DAYS,
      DEFAULT_ORIGIN_LOOKBACK_DAYS
    ),
    incidentWindowHours: positiveNumber(
      env.BREACH_WATCH_INCIDENT_WINDOW_HOURS,
      DEFAULT_INCIDENT_WINDOW_HOURS
    ),
    updateIntervalHours: positiveNumber(
      env.BREACH_WATCH_UPDATE_INTERVAL_HOURS,
      DEFAULT_UPDATE_INTERVAL_HOURS
    ),
    minPrefixesPerOrigin: positiveNumber(
      env.BREACH_WATCH_MIN_PREFIXES_PER_ORIGIN,
      PROVISIONAL_MIN_PREFIXES_PER_ORIGIN
    ),
  };
}

export interface BreachWatchSchedulerDecision {
  enabled: boolean;
  intervalMs: number;
  statePath: string;
  channelName: string;
  reason: string;
}

/** Pure: the decision plus a human-readable reason, for a single log line at boot. */
export function describeBreachWatchSchedulerStart(
  env: NodeJS.ProcessEnv = process.env
): BreachWatchSchedulerDecision {
  const enabled = shouldScheduleBreachWatch(env);
  const intervalMs = resolveBreachWatchIntervalMs(env);
  const statePath = resolveIncidentStatePath(env);
  const configured = resolvePaperclipConfig(env) !== null;

  return {
    enabled,
    intervalMs,
    statePath,
    channelName: configured ? 'paperclip' : 'logging',
    reason: !enabled
      ? 'BREACH_WATCH_ENABLED is false'
      : configured
        ? `checking every ${Math.round(intervalMs / 60_000)}m, incidents open as priority:high ` +
          `Paperclip issues, state at ${statePath}`
        : `checking every ${Math.round(intervalMs / 60_000)}m, but PAPERCLIP_API_KEY / ` +
          'PAPERCLIP_API_URL / PAPERCLIP_COMPANY_ID are unset — a detected signal will be ' +
          'LOGGED ONLY and nobody will be woken (ABL-524 §6 requires a Paperclip issue)',
  };
}

/** The store reads the check needs. Injectable, so the whole path is testable without SQLite. */
export interface BreachWatchSource {
  read(window: AuthFailureWindow, originLookbackSince: string): {
    byOrigin: ReturnType<AuthFailureAdminStore['failuresByOrigin']>;
    secretHolderRows: ReturnType<AuthFailureAdminStore['secretHolderFailures']>;
    keyOriginRows: ReturnType<AuthFailureAdminStore['keyOrigins']>;
  };
  close(): void;
}

export interface BreachWatchCheckDeps {
  /** Returns `null` when there is nothing to watch — never an alarm. See the reader. */
  openSource?: (env: NodeJS.ProcessEnv) => BreachWatchSource | { reason: string };
  channel?: IncidentChannel;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Overrides the 90-day figure the incident body quotes. */
  piiDays?: number;
  logger?: { warn: (m: string) => void; error: (m: string) => void; log: (m: string) => void };
}

export interface BreachWatchCheckResult {
  findings: BreachFinding[];
  opened: string[];
  updated: string[];
  /** Findings suppressed because an incident for the same subject is already open. */
  suppressed: string[];
  /** Non-null when there was nothing to read. Not a failure. */
  unavailable: string | null;
  warnings: string[];
}

/**
 * Loaded on first use, not at module import — the same trap
 * `opsAlertScheduler.ts` and `forecastVintageArchiveScheduler.ts` avoid. The
 * reader imports `better-sqlite3` and opens a file; a static import here would
 * mean that merely importing this scheduler from `index.ts` or from a test opened
 * a database. Keeping it dynamic is what lets this module's tests run as pure
 * logic with no fixture database.
 */
async function defaultOpenSource(
  env: NodeJS.ProcessEnv
): Promise<BreachWatchSource | { reason: string }> {
  const { openAuthFailureReader, isUnavailable } = await import('./breachWatch/authFailureReader.js');
  const opened = openAuthFailureReader(env);
  if (isUnavailable(opened)) return { reason: opened.reason };

  return {
    read(window, originLookbackSince) {
      return {
        byOrigin: opened.store.failuresByOrigin(window),
        secretHolderRows: opened.store.secretHolderFailures(window),
        // Deliberately unwindowed — `keyOrigins` cannot answer "has this key ever
        // been used from here" from a window, because every origin looks new if
        // you only fetch the last week. The lookback is applied by the classifier.
        keyOriginRows: opened.store.keyOrigins(),
      };
    },
    close: opened.close,
  };
}

function resolvePiiDays(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined) return override;
  const parsed = Number(env.USAGE_RETENTION_PII_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
}

/**
 * One evaluation.
 *
 * Nothing in here is allowed to throw. A failure to read, deliver or persist is
 * collected as a warning and the scheduler keeps ticking — a monitor that dies on
 * its own transport is strictly worse than one that logs and carries on.
 *
 * The delivery-failure rule is `runOpsAlertCheck`'s, and it is the important one:
 * **an incident that failed to deliver is not recorded**. Recording it would mark
 * the subject as "already reported" for something nobody received, and the attack
 * would then never be mentioned again. Leaving the record absent means the next
 * tick retries.
 */
export async function runBreachWatchCheck(
  deps: BreachWatchCheckDeps = {}
): Promise<BreachWatchCheckResult> {
  const { env = process.env, now = new Date(), logger = console } = deps;
  const openSource = deps.openSource ?? defaultOpenSource;
  const warnings: string[] = [];
  const empty = { findings: [], opened: [], updated: [], suppressed: [] };

  let source: BreachWatchSource | { reason: string };
  try {
    source = await openSource(env);
  } catch (err) {
    warnings.push(`breach watch could not open the /v1 store: ${(err as Error).message}`);
    for (const warning of warnings) logger.error(`🚨 ${warning}`);
    return { ...empty, unavailable: null, warnings };
  }

  if ('reason' in source) {
    // Not a warning and not an alarm: there is no /v1 store in this deployment.
    return { ...empty, unavailable: source.reason, warnings };
  }

  const settings = resolveBreachWatchSettings(env);
  const window: AuthFailureWindow = {
    since: new Date(now.getTime() - settings.windowHours * 3_600_000).toISOString(),
    until: now.toISOString(),
  };
  const originLookbackSince = new Date(
    now.getTime() - settings.originLookbackDays * 86_400_000
  ).toISOString();

  let findings: BreachFinding[];
  try {
    const rows = source.read(window, originLookbackSince);
    findings = detectBreachSignals({
      window,
      byOrigin: rows.byOrigin,
      secretHolderRows: rows.secretHolderRows,
      keyOriginRows: rows.keyOriginRows,
      originLookbackSince,
      minPrefixesPerOrigin: settings.minPrefixesPerOrigin,
    });
  } catch (err) {
    warnings.push(`breach watch could not read the /v1 store: ${(err as Error).message}`);
    for (const warning of warnings) logger.error(`🚨 ${warning}`);
    return { ...empty, unavailable: null, warnings };
  } finally {
    try {
      source.close();
    } catch {
      // A handle that will not close is not worth failing a security check over.
    }
  }

  const channel =
    deps.channel ??
    (() => {
      const config = resolvePaperclipConfig(env);
      return config
        ? createPaperclipIncidentChannel({ config, logger })
        : createLoggingIncidentChannel(logger);
    })();

  const statePath = resolveIncidentStatePath(env);
  const { state: stored, warning: readWarning } = readIncidentState(statePath);
  if (readWarning) warnings.push(readWarning);

  let state = pruneLapsed(stored, now);
  const context: IncidentContext = {
    window,
    originLookbackSince,
    piiDays: resolvePiiDays(env, deps.piiDays),
    minPrefixesPerOrigin: settings.minPrefixesPerOrigin,
    observedAt: now.toISOString(),
  };

  const opened: string[] = [];
  const updated: string[] = [];
  const suppressed: string[] = [];

  for (const finding of findings) {
    const existing = findIncident(state, finding.incidentKey);
    const outcome = await deliverFinding({
      finding,
      existing,
      channel,
      context,
      now,
      settings,
      warnings,
    });
    if (outcome.record) state = upsertIncident(state, outcome.record);
    if (outcome.kind === 'opened') opened.push(outcome.reference);
    if (outcome.kind === 'updated') updated.push(finding.incidentKey);
    if (outcome.kind === 'suppressed') suppressed.push(finding.incidentKey);
  }

  const { warning: writeWarning } = writeIncidentState(statePath, state);
  if (writeWarning) warnings.push(writeWarning);

  for (const warning of warnings) logger.error(`🚨 ${warning}`);

  return { findings, opened, updated, suppressed, unavailable: null, warnings };
}

interface DeliverOutcome {
  kind: 'opened' | 'updated' | 'suppressed' | 'failed';
  reference: string;
  /** Absent when delivery failed — see the rule in `runBreachWatchCheck`. */
  record: IncidentRecord | null;
}

/**
 * "Is the incident I remember still somewhere a responder will look?"
 *
 * The state file records that an issue was opened; it cannot record that somebody
 * has since triaged and closed it. Without this check, a signal that keeps firing
 * after a dismissal is silent for the rest of the 24h window, or — if the count
 * grows — comments onto a closed thread, where an agent comment is inert by
 * default. Either way the second attack lands nowhere. *One open incident per
 * window* has to mean **open**.
 *
 * Only a definite `false` forgets the record. A channel that cannot answer, or one
 * with no issues to check, keeps it: re-opening on an unanswered question would
 * duplicate a live incident every tick on nothing worse than a flaky network.
 */
async function stillOpen(
  channel: IncidentChannel,
  existing: IncidentRecord | undefined,
  warnings: string[]
): Promise<boolean> {
  if (!existing || existing.issueId === null || !channel.isOpen) return true;
  try {
    return (await channel.isOpen(existing.issueId)) !== false;
  } catch (err) {
    warnings.push(
      `breach watch could not tell whether incident ${existing.issueId} is still open ` +
        `(${(err as Error).message}); treating it as open, so this tick will not duplicate it.`
    );
    return true;
  }
}

async function deliverFinding({
  finding,
  existing: remembered,
  channel,
  context,
  now,
  settings,
  warnings,
}: {
  finding: BreachFinding;
  existing: IncidentRecord | undefined;
  channel: IncidentChannel;
  context: IncidentContext;
  now: Date;
  settings: BreachWatchSettings;
  warnings: string[];
}): Promise<DeliverOutcome> {
  const closed = !(await stillOpen(channel, remembered, warnings));
  const existing = closed ? undefined : remembered;

  if (!existing) {
    try {
      const result = await channel.open(
        buildIncident(
          finding,
          context,
          closed && remembered?.issueId ? { closedIssueId: remembered.issueId } : undefined
        )
      );
      return {
        kind: 'opened',
        reference: result.reference,
        record: {
          key: finding.incidentKey,
          issueId: result.issueId,
          openedAt: now.toISOString(),
          windowEndsAt: new Date(
            now.getTime() + settings.incidentWindowHours * 3_600_000
          ).toISOString(),
          lastNotifiedAt: now.toISOString(),
          magnitude: finding.magnitude,
        },
      };
    } catch (err) {
      warnings.push(
        `breach watch could not open an incident for ${finding.incidentKey} via ` +
          `${channel.name} (${(err as Error).message}). NOBODY HAS BEEN TOLD; nothing was ` +
          'recorded, so the next tick retries.'
      );
      return { kind: 'failed', reference: finding.incidentKey, record: null };
    }
  }

  const grew = finding.magnitude > existing.magnitude;
  const dueAt = Date.parse(existing.lastNotifiedAt) + settings.updateIntervalHours * 3_600_000;
  if (!grew || now.getTime() < dueAt || existing.issueId === null) {
    // Still open, and either unchanged, too soon to comment again, or delivered
    // somewhere we cannot address. Keep the record exactly as it is — advancing
    // `lastNotifiedAt` here would silently push the next update further away
    // every tick, and a rising attack would go quiet the longer it ran.
    return { kind: 'suppressed', reference: finding.incidentKey, record: null };
  }

  try {
    await channel.update(
      existing.issueId,
      buildUpdateComment(finding, existing.magnitude, context)
    );
    return {
      kind: 'updated',
      reference: finding.incidentKey,
      record: { ...existing, lastNotifiedAt: now.toISOString(), magnitude: finding.magnitude },
    };
  } catch (err) {
    warnings.push(
      `breach watch could not update incident ${existing.issueId} for ${finding.incidentKey} ` +
        `via ${channel.name} (${(err as Error).message}). The issue is open; this growth was ` +
        'not added to it, and the next tick retries.'
    );
    return { kind: 'failed', reference: finding.incidentKey, record: null };
  }
}

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * Starts the recurring check. Ticks once immediately so a restart re-establishes
 * the picture without waiting out a full interval, then on the timer. An
 * in-flight guard skips rather than overlaps: a tick opens issues over HTTP, and
 * two concurrent passes could both see the same finding as new and open it twice
 * — the exact duplication the state file exists to prevent.
 */
export function startBreachWatchScheduler(
  env: NodeJS.ProcessEnv = process.env,
  deps: BreachWatchCheckDeps = {}
): SchedulerHandle | null {
  const decision = describeBreachWatchSchedulerStart(env);
  console.log(`🛡  Breach watch (ABL-578): ${decision.reason}`);
  if (!decision.enabled) return null;

  let running = false;
  let reportedUnavailable = false;

  const tick = () => {
    if (running) {
      console.log('🛡  Breach watch: previous check still running, skipping this tick.');
      return;
    }
    running = true;
    runBreachWatchCheck({ ...deps, env })
      .then((result) => {
        if (result.unavailable) {
          // Once, not every tick. This is the ordinary state of a checkout and of
          // any deployment not running /v1, and a line every 15 minutes saying so
          // would train everyone to ignore this prefix.
          if (!reportedUnavailable) {
            console.log(`🛡  Breach watch: ${result.unavailable}`);
            reportedUnavailable = true;
          }
          return;
        }
        reportedUnavailable = false;
        if (result.opened.length > 0) {
          console.error(`🚨 Breach watch OPENED ${result.opened.length} incident(s): ${result.opened.join(', ')}`);
        }
        if (result.updated.length > 0) {
          console.error(`🚨 Breach watch updated ${result.updated.length} open incident(s).`);
        }
      })
      .catch((error) => {
        // runBreachWatchCheck is written not to reject; this is the belt to that
        // braces, so an unforeseen throw cannot kill the interval.
        console.error('🚨 Breach watch check failed:', error);
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
