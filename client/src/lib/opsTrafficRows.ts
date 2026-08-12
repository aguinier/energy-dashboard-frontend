import type { VisitorCounters } from '@/types';

/**
 * Turns `/api/ops/status`'s `visitors` block into the rows the ops status card
 * renders (ABL-289). Pure, so the awkward cases — a build that does not report
 * counters at all, a process younger than its own 7-day window, a distinct
 * count the server gave up on — are table-driven tests rather than JSX.
 *
 * The rule this file exists to enforce: **no figure leaves here without its
 * caveat attached.** The counters are in-memory and per process, so a restart
 * zeroes them; "12 in 7d" from a container that came up an hour ago is a wrong
 * number, and "12 in 7d (partial)" is not.
 */

export interface TrafficRow {
  label: string;
  value: string;
  /** Longer explanation for a `title` attribute — the caveat in full. */
  detail?: string;
}

export interface TrafficBlock {
  /** e.g. `Since 12 Aug 09:14 UTC` — the scope every row below is measured over. */
  since: string;
  rows: TrafficRow[];
  /** True when the 7-day figures cover fewer than seven full days. */
  partialWindow: boolean;
}

/** Locale-independent so a test does not depend on the runner's locale. */
function formatCount(value: number): string {
  return value.toLocaleString('en-GB');
}

/** `2026-08-12T09:14:00.000Z` → `12 Aug 09:14 UTC`. UTC, because the buckets are. */
export function formatCountingSince(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'an unknown time';
  const day = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const time = at.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return `${day} ${time} UTC`;
}

function pair(today: number, window: number, partialWindow: boolean): string {
  const windowPart = partialWindow ? `${formatCount(window)} so far` : `${formatCount(window)} in 7d`;
  return `${formatCount(today)} today · ${windowPart}`;
}

/**
 * `null` when this side reports no counters — a peer running a build from
 * before ABL-289. The caller renders that as "not reported by this build",
 * which is true, rather than as zeros, which are not.
 */
export function buildTrafficBlock(visitors: VisitorCounters | undefined): TrafficBlock | null {
  if (!visitors) return null;

  const partial = !visitors.windowComplete;
  const { today, window } = visitors;
  const sinceLabel = formatCountingSince(visitors.countingSince);
  const partialDetail = partial
    ? `Counting since ${sinceLabel} — ${visitors.windowDaysCovered} of 7 days observed. In-memory per process: a restart resets this.`
    : undefined;

  return {
    since: sinceLabel,
    partialWindow: partial,
    rows: [
      {
        label: 'Page views',
        value: pair(today.page, window.page, partial),
        detail: partialDetail ?? 'SPA document loads — one per visit or hard refresh.',
      },
      {
        label: 'App API calls',
        value: pair(today.api, window.api, partial),
        detail: 'Data calls the dashboard made for a visitor. Excludes /api/health and /api/ops/*.',
      },
      {
        label: 'Distinct clients',
        value:
          visitors.distinctClientsToday === null
            ? 'too many to count today'
            : `${formatCount(visitors.distinctClientsToday)} today`,
        detail:
          visitors.distinctClientsToday === null
            ? "Past the server's per-day cap, so this is no longer measurable — reported as unknown rather than frozen at the cap."
            : 'Estimated from hashed ip+user-agent. A household behind one address reads as one; one person on two devices reads as two.',
      },
      {
        label: 'Automated',
        value: pair(today.automated, window.automated, partial),
        detail: 'Health checks, the peer ops poll, ingest writes and recognised bot/CLI user agents.',
      },
    ],
  };
}
