import type { ThresholdState } from './opsStatusThresholds.js';
import type { AlertObservation, AlertKpi, AlertLane } from './opsAlertRules.js';

/**
 * Transition detection and de-duplication for the ops alert engine (ABL-287).
 *
 * Pure — no clock, no filesystem, no HTTP. Everything that decides whether a
 * human hears about a KPI is in `evaluateAlerts`, so every rule below is a
 * table-driven unit test rather than something you confirm by watching a log
 * for a day.
 *
 * THE PROPERTY THAT MATTERS: ALERT ON TRANSITION, NOT ON LEVEL
 *
 * A job that re-sends "disk at 91%" every five minutes trains everyone to
 * ignore it, which is worse than no alerting at all. So the engine remembers
 * the state it last *told a human about*, per KPI, and emits only when the
 * current verdict differs from that.
 */

/**
 * The states worth remembering. `'unknown'` is deliberately absent: the engine
 * never records "we failed to measure" as a thing it told someone, so a stored
 * entry is always a real verdict. See the unknown rule below.
 */
export type RecordedState = 'ok' | 'warn' | 'error';

export interface AlertStateEntry {
  key: string;
  state: RecordedState;
  /** ISO timestamp of the evaluation that last emitted for this key. */
  firedAt: string;
}

export interface AlertState {
  version: 1;
  entries: AlertStateEntry[];
}

export const EMPTY_ALERT_STATE: AlertState = { version: 1, entries: [] };

export type AlertKind = 'breach' | 'escalation' | 'improvement' | 'recovery';

export interface AlertNotification {
  key: string;
  lane: AlertLane;
  kpi: AlertKpi;
  /** `null` on the very first evaluation of a key — nothing was ever recorded. */
  previousState: RecordedState | null;
  state: RecordedState;
  kind: AlertKind;
  /** What a delivery channel should treat this as. Recoveries are `'info'`, never `'ok'`. */
  severity: 'warn' | 'error' | 'info';
  detail: string;
  observedAt: string;
}

export interface EvaluateOptions {
  now: Date;
  /** `syncBlackout.active` from the same payload the observations came from. */
  blackoutActive: boolean;
}

export interface EvaluateResult {
  notifications: AlertNotification[];
  /** The record to persist. Callers must write this even when `notifications` is empty. */
  state: AlertState;
}

function isRecordedState(state: ThresholdState): state is RecordedState {
  return state === 'ok' || state === 'warn' || state === 'error';
}

const RANK: Record<RecordedState, number> = { ok: 0, warn: 1, error: 2 };

/**
 * Which transitions are worth a human's attention, given a previous recorded
 * state and the current verdict. `null` previous means first-ever evaluation.
 *
 * FIRST-RUN RULE (the one the issue calls out explicitly): `null -> warn|error`
 * fires. An engine that only fired on a change *from* `ok` would boot into an
 * already-breached world — at the time this was written, acceptance disk was at
 * 85.11% (warn) and freshness was stale on both lanes — record "no change", and
 * stay silent about both of them forever. `null -> ok` does not fire: there is
 * nothing to tell anyone, but the `ok` is still recorded so the *next* breach
 * reads as a transition.
 */
function classifyTransition(
  previous: RecordedState | null,
  current: RecordedState,
): AlertKind | null {
  if (previous === null) return current === 'ok' ? null : 'breach';
  if (previous === current) return null;
  if (current === 'ok') return 'recovery';
  if (previous === 'ok') return 'breach';
  return RANK[current] > RANK[previous] ? 'escalation' : 'improvement';
}

function severityFor(kind: AlertKind, state: RecordedState): AlertNotification['severity'] {
  if (kind === 'recovery') return 'info';
  return state === 'error' ? 'error' : 'warn';
}

/**
 * Compares this tick's verdicts against what was last reported and returns both
 * the notifications to deliver and the record to persist.
 *
 * Two rules suppress a notification *and* leave the stored entry untouched.
 * Both hinge on the same idea: the engine's memory is "what I last told a
 * human", so an evaluation with nothing trustworthy to say must not overwrite
 * it.
 *
 *  1. **The unknown rule.** A `'unknown'` verdict means we did not measure the
 *     KPI — an unreachable side, a host with no disk reading, two lanes with no
 *     comparable commit. That is never a recovery and never a breach. Crucially
 *     it also must not be *recorded*: if `unknown` overwrote a stored `warn`,
 *     the next real `warn` would read as `unknown -> warn` and re-fire under
 *     the first-run rule, so a KPI that flickers out of measurement would page
 *     on every flicker. Holding the previous entry makes
 *     `warn -> unmeasured -> warn` silent and `warn -> unmeasured -> ok` a
 *     correct, single recovery.
 *
 *  2. **The blackout rule (ABL-220).** Inside the twice-daily DB write-lock
 *     window, the database-backed KPIs — reachability and freshness — are
 *     expected to fail, and that window is documented as a known state, not an
 *     outage (`syncBlackoutWindow.ts`, `WORKFLOWS.md`). Those observations are
 *     held exactly like `unknown` ones: no breach *and* no recovery, since a
 *     "recovered" notice derived from a blackout reading is as wrong as an
 *     outage one. Disk and commit drift do not reach the database and are not
 *     held — a disk filling up at 07:00 is still a disk filling up.
 *
 * Entries for keys not present in `observations` are dropped rather than
 * carried, so a KPI removed from the rule set does not leave a permanent
 * orphan in the record. The rule set is fixed (`observeCombinedStatus` always
 * returns the same seven keys), so in practice this only prunes across a
 * deliberate change to that set.
 */
export function evaluateAlerts(
  observations: AlertObservation[],
  previous: AlertState,
  options: EvaluateOptions,
): EvaluateResult {
  const previousByKey = new Map(previous.entries.map((entry) => [entry.key, entry]));
  const observedAt = options.now.toISOString();

  const notifications: AlertNotification[] = [];
  const entries: AlertStateEntry[] = [];

  for (const observation of observations) {
    const prior = previousByKey.get(observation.key) ?? null;
    const held =
      !isRecordedState(observation.state) ||
      (options.blackoutActive && observation.blackoutSensitive);

    if (held) {
      if (prior) entries.push(prior);
      continue;
    }

    const current = observation.state as RecordedState;
    const kind = classifyTransition(prior?.state ?? null, current);

    if (kind === null) {
      // No transition. Keep the prior entry verbatim so `firedAt` stays the
      // moment we last spoke about this KPI, not the moment we last looked at
      // it. The `??` covers exactly one case — the silent first-run `ok`
      // baseline, which has no earlier mention to preserve.
      entries.push(prior ?? { key: observation.key, state: current, firedAt: observedAt });
      continue;
    }

    notifications.push({
      key: observation.key,
      lane: observation.lane,
      kpi: observation.kpi,
      previousState: prior?.state ?? null,
      state: current,
      kind,
      severity: severityFor(kind, current),
      detail: observation.detail,
      observedAt,
    });
    entries.push({ key: observation.key, state: current, firedAt: observedAt });
  }

  return { notifications, state: { version: 1, entries } };
}
