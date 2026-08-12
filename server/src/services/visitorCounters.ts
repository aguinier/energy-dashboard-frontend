import { createHash, randomBytes } from 'node:crypto';
import type { RequestLane } from '../lib/classifyRequest.js';

/**
 * Per-day request counts for `/ops-status` (ABL-289).
 *
 * **In-memory, per process, and it says so.** The energy database is opened
 * readonly (`config/database.ts`) and is owned by the sibling
 * `energy-data-gathering` module, so a counter table there is a schema change
 * this repo is not allowed to make. Writing a counter file into the mounted
 * `/data` volume would put dashboard state inside the data module's directory
 * for the same reason. So the counts live in this process and reset when it
 * restarts — which is *fine* only because every payload carries
 * `countingSince` and `windowComplete`, and the page renders them. A visitor
 * counter that silently reads "4 this week" because the container restarted an
 * hour ago is exactly the confidently-wrong-number failure this codebase keeps
 * having; one that says "4 since 14:32 today" is not.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Today plus the six days behind it, and one day of slack for a clock that steps back. */
const RETAINED_DAYS = 8;

/** The rolling window the page headlines, in days, today inclusive. */
export const WINDOW_DAYS = 7;

/**
 * Ceiling on distinct client keys held for one day.
 *
 * Unbounded, this set is a memory leak with an attacker-controlled key. At the
 * cap the day's distinct count becomes `null` rather than a number that has
 * stopped rising — a counter frozen at 20,000 while traffic keeps arriving is
 * a wrong number, and `null` is the house answer for "we can no longer measure
 * this".
 */
export const DISTINCT_CLIENT_CAP = 20_000;

export type LaneCounts = Record<RequestLane, number>;

export interface VisitorCounters {
  /** When this process started counting. Every figure below is "since" this. */
  countingSince: string;
  /** UTC day the `today` figures belong to, `YYYY-MM-DD`. */
  day: string;
  today: LaneCounts;
  /** The `WINDOW_DAYS` UTC days ending on `day`, inclusive. */
  window: LaneCounts;
  /** Days in the window this process was actually up for — 1 on a fresh restart. */
  windowDaysCovered: number;
  /** False when `countingSince` is after the window's first midnight, i.e. `window` is a partial count. */
  windowComplete: boolean;
  /**
   * Distinct `sha256(salt, ip, user-agent)` keys seen today across the
   * non-`automated` lanes. An estimate of people, not a measurement of them:
   * one household behind NAT reads as one, one person on a phone and a laptop
   * reads as two. `null` once `DISTINCT_CLIENT_CAP` is reached.
   */
  distinctClientsToday: number | null;
}

function emptyLanes(): LaneCounts {
  return { page: 0, api: 0, asset: 0, automated: 0 };
}

/** `YYYY-MM-DD` in UTC. UTC, not local, so the buckets do not shift under DST. */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function startOfUtcDay(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

interface DayBucket {
  lanes: LaneCounts;
  clients: Set<string>;
  clientsCapped: boolean;
}

export interface VisitorCounterStore {
  record(lane: RequestLane, clientKey: string | null, at: Date): void;
  clientKeyFor(ip: string | undefined, userAgent: string | undefined): string | null;
  snapshot(at: Date): VisitorCounters;
  /** Test seam — drops every bucket and restarts the counting clock. */
  reset(startedAt: Date): void;
}

/**
 * A fresh store. Exported as a factory so `visitorCounters.test.ts` can drive a
 * clock and a client population without touching the module singleton the
 * middleware uses (and without one test's traffic leaking into another's).
 */
export function createVisitorCounterStore(startedAt: Date = new Date()): VisitorCounterStore {
  let countingSince = startedAt;
  const days = new Map<string, DayBucket>();

  /**
   * Per-process random salt. The stored key is a hash of it with the client's
   * IP and UA, never the IP itself, and the salt dies with the process — so
   * nothing here can be correlated across restarts or read back into an
   * address. The counter needs set membership, not identity.
   */
  const salt = randomBytes(32);

  function bucketFor(dayKey: string): DayBucket {
    let bucket = days.get(dayKey);
    if (!bucket) {
      bucket = { lanes: emptyLanes(), clients: new Set(), clientsCapped: false };
      days.set(dayKey, bucket);
    }
    return bucket;
  }

  function prune(at: Date): void {
    if (days.size <= RETAINED_DAYS) return;
    const cutoff = startOfUtcDay(at) - (RETAINED_DAYS - 1) * DAY_MS;
    for (const key of days.keys()) {
      if (Date.parse(`${key}T00:00:00Z`) < cutoff) days.delete(key);
    }
  }

  return {
    record(lane, clientKey, at) {
      const bucket = bucketFor(utcDayKey(at));
      bucket.lanes[lane] += 1;

      // Automated traffic is explicitly not a client we are counting people
      // from — the peer poller would otherwise be a "distinct client" forever.
      if (clientKey !== null && lane !== 'automated' && !bucket.clientsCapped) {
        if (bucket.clients.size >= DISTINCT_CLIENT_CAP && !bucket.clients.has(clientKey)) {
          bucket.clientsCapped = true;
          bucket.clients.clear(); // The count is `null` from here; the set is dead weight.
        } else {
          bucket.clients.add(clientKey);
        }
      }

      prune(at);
    },

    clientKeyFor(ip, userAgent) {
      if (!ip) return null;
      return createHash('sha256')
        .update(salt)
        .update(ip)
        .update('\n')
        .update(userAgent ?? '')
        .digest('hex')
        .slice(0, 16);
    },

    snapshot(at) {
      const dayKey = utcDayKey(at);
      const today = days.get(dayKey);
      const windowLanes = emptyLanes();

      const windowStartMs = startOfUtcDay(at) - (WINDOW_DAYS - 1) * DAY_MS;
      for (let i = 0; i < WINDOW_DAYS; i += 1) {
        const bucket = days.get(utcDayKey(new Date(windowStartMs + i * DAY_MS)));
        if (!bucket) continue;
        windowLanes.page += bucket.lanes.page;
        windowLanes.api += bucket.lanes.api;
        windowLanes.asset += bucket.lanes.asset;
        windowLanes.automated += bucket.lanes.automated;
      }

      const sinceMs = countingSince.getTime();
      const observedMs = startOfUtcDay(at) + DAY_MS - Math.max(sinceMs, windowStartMs);

      return {
        countingSince: countingSince.toISOString(),
        day: dayKey,
        today: today ? { ...today.lanes } : emptyLanes(),
        window: windowLanes,
        // Ceil, not round: a process 10 minutes old has covered one day of the
        // window, partially. `windowComplete` is what says whether that is enough.
        windowDaysCovered: Math.min(WINDOW_DAYS, Math.max(1, Math.ceil(observedMs / DAY_MS))),
        windowComplete: sinceMs <= windowStartMs,
        distinctClientsToday: !today ? 0 : today.clientsCapped ? null : today.clients.size,
      };
    },

    reset(startedAt2) {
      countingSince = startedAt2;
      days.clear();
    },
  };
}

/** The store the request-counting middleware writes to and `/api/ops/status` reads. */
export const visitorCounters = createVisitorCounterStore();
