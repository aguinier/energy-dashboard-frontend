import { laneLabel } from '../lib/opsAlertRules.js';
import type { AlertNotification } from '../lib/opsAlertEngine.js';

/**
 * Where an ops alert goes (ABL-287).
 *
 * **Logging is the only channel in this issue, by Board decision (2026-08-12).**
 * Mail was explicitly deferred: no SMTP config, no credentials, not even
 * stubbed credential handling. The interface exists so that adding one later is
 * one adapter and a config line rather than a rewrite of the engine — not
 * because a second implementation is half-built here. There is none.
 *
 * `deliver` returns a promise and is allowed to reject; every caller must
 * swallow that (see `runOpsAlertCheck`). A monitoring job that dies because its
 * transport is unauthenticated is strictly worse than one that logs the failure
 * and carries on.
 */
export interface AlertChannel {
  name: string;
  deliver(notifications: AlertNotification[]): Promise<void>;
}

const KIND_PREFIX: Record<AlertNotification['kind'], string> = {
  breach: 'BREACH',
  escalation: 'ESCALATION',
  improvement: 'IMPROVED',
  recovery: 'RECOVERED',
};

/**
 * One line per notification, carrying the transition and the evidence that
 * justified it — "85.11% of disk used (warn; warn at 75%, error at 90%)" rather
 * than "disk warn". Pure, so the wording is pinned by a test instead of by
 * reading logs.
 *
 * `previousState` renders as `unknown` only in the first-run case, where there
 * genuinely was no prior record. That is a statement about our memory, not
 * about the KPI.
 */
export function formatNotification(notification: AlertNotification): string {
  const { kind, kpi, lane, previousState, state, detail, observedAt } = notification;
  const from = previousState ?? 'unknown';
  return `[${KIND_PREFIX[kind]}] ${kpi} on ${laneLabel(lane)}: ${from} -> ${state} — ${detail} (at ${observedAt})`;
}

export interface AlertLogger {
  warn: (message: string) => void;
  error: (message: string) => void;
  log: (message: string) => void;
}

/**
 * The default channel: routes by severity so an `error` transition is visible
 * in whatever collects stderr, and recoveries stay at `log` level.
 */
export function createLoggingChannel(logger: AlertLogger = console): AlertChannel {
  return {
    name: 'logging',
    async deliver(notifications: AlertNotification[]): Promise<void> {
      for (const notification of notifications) {
        const line = `🚨 ${formatNotification(notification)}`;
        if (notification.severity === 'error') logger.error(line);
        else if (notification.severity === 'warn') logger.warn(line);
        else logger.log(line);
      }
    },
  };
}
