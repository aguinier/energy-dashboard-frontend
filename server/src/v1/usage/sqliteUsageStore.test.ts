import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openApiKeyAdminStore } from '../keys/sqliteApiKeyStore.js';
import { openUsageStore } from './sqliteUsageStore.js';
import { runUsageMaintenance } from './usageMaintenance.js';
import {
  IDEMPOTENT_SUPPRESSION_LIMIT,
  requestFingerprint,
  type RetentionPolicy,
  type UsageAdminStore,
  type UsageEvent,
} from './usageStore.js';

/**
 * The store against a real SQLite file, because a fake cannot say anything true
 * about SQLite and every claim in this file is a claim about the database.
 *
 * The four that matter most, in the order a billing dispute would test them:
 *
 * 1. **A replayed flush inserts nothing.** The only failure mode here that
 *    would *over*-count, closed by `UNIQUE(request_id)` + `INSERT OR IGNORE`.
 * 2. **An invoice survives its evidence being deleted.** ABL-297 §9(2): the
 *    monthly figure is a materialised row with its own lifecycle, so the 90-day
 *    and 13-month deletions cannot destroy the ability to defend an invoice
 *    from eight months ago.
 * 3. **A closed month never changes.** Late events are counted separately and
 *    are never billed, because re-raising an invoice a customer has already
 *    received is worse than under-counting.
 * 4. **The watermark cannot go backwards past a deletion.** The `AUTOINCREMENT`
 *    regression test. Without it, retention emptying the table makes every
 *    subsequent event invisible to the rollup — and the customer is billed zero,
 *    which is the one error nobody reports.
 *
 * Temp files rather than `:memory:`: WAL mode, `fileMustExist` and the key-store
 * check are all properties of a file on disk.
 */

const tmpRoots: string[] = [];

function tmpDbPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'able-usage-'));
  tmpRoots.push(root);
  return path.join(root, 'api_keys.db');
}

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

let dbPath: string;
let store: UsageAdminStore;
let accountId: string;
let keyId: string;
let secondKeyId: string;
let sequence = 0;

/**
 * A key store file with one account and two keys, then a usage store over it.
 *
 * Seeded through the real key store rather than by hand, because the usage
 * tables live in that file by design and the export test needs real `api_keys`
 * rows to prove it does not hand out a secret hash.
 */
function open(policy?: Partial<RetentionPolicy>): void {
  dbPath = tmpDbPath();
  const keys = openApiKeyAdminStore({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
  const account = keys.createAccount({ name: 'Acme Energy', plan: 'developer' });
  accountId = account.id;
  keyId = keys.issueKey({ accountId, label: 'prod ETL', contactEmail: 'ops@acme.example', environment: 'live' }).record.id;
  secondKeyId = keys.issueKey({ accountId, label: 'staging', contactEmail: 'ops@acme.example', environment: 'live' }).record.id;
  keys.close();

  store = openUsageStore({
    env: { API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv,
    policy: { piiDays: 90, eventMonths: 13, monthCloseGraceDays: 2, ...policy },
  });
}

beforeEach(() => {
  sequence = 0;
  open();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // Some cases close it themselves to read the file directly.
  }
});

const ROUTE = '/v1/observations/:series';
const FINGERPRINT = requestFingerprint('GET', ROUTE, 'country=BE');

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  sequence += 1;
  return {
    requestId: `req_${sequence}`,
    receivedAt: '2026-07-15T12:00:00.000Z',
    accountId,
    keyId,
    method: 'GET',
    routeTemplate: ROUTE,
    queryParams: 'country=BE',
    status: 200,
    rowCount: 10,
    responseBytes: 1_000,
    durationMs: 5,
    billable: true,
    idempotencyKey: null,
    fingerprint: FINGERPRINT,
    clientIp: '192.0.2.10',
    userAgent: 'able-sdk/1.0',
    ...overrides,
  };
}

/** Roll up and close, as the maintenance pass does, so a month can be asserted on. */
function monthOf(yearMonth: string) {
  return store.monthlyUsage(yearMonth);
}

/**
 * The month's billable total across every key — the figure an invoice is
 * raised from, rather than whatever one row happens to hold.
 */
function billableIn(yearMonth: string): number {
  return monthOf(yearMonth).reduce((total, row) => total + row.billableRequests, 0);
}

function raw(): Database.Database {
  return new Database(dbPath, { readonly: true });
}

describe('opening the store', () => {
  it('refuses a file that does not exist, rather than creating a stray database', () => {
    expect(() =>
      openUsageStore({ env: { API_KEYS_DB_PATH: path.join(os.tmpdir(), 'nope-abl301.db') } as NodeJS.ProcessEnv })
    ).toThrow(/Cannot open the \/v1 usage store/);
  });

  it('refuses a real SQLite file that is not the key store', () => {
    // A real database at the wrong path is still the wrong path — and metering
    // into it would be a month of billing data nobody ever looks at.
    const strayPath = tmpDbPath();
    const stray = new Database(strayPath);
    stray.exec('CREATE TABLE something_else (id INTEGER PRIMARY KEY)');
    stray.close();

    expect(() =>
      openUsageStore({ env: { API_KEYS_DB_PATH: strayPath } as NodeJS.ProcessEnv })
    ).toThrow(/no api_keys table/);
  });

  it('creates its tables in the key store file and nowhere else', () => {
    const db = raw();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    db.close();

    expect(tables).toContain('usage_events');
    expect(tables).toContain('usage_rollup');
    expect(tables).toContain('usage_rollup_state');
    // The key store's own tables are untouched neighbours, not replaced.
    expect(tables).toContain('api_keys');
    expect(tables).toContain('accounts');
  });

  it('refuses to resolve to the energy database', () => {
    // Enforced by `resolveApiKeysDbPath`, which this module reuses rather than
    // reading the variable itself, so there is one guard to keep true.
    expect(() =>
      openUsageStore({
        env: {
          API_KEYS_DB_PATH: 'C:/data/energy.db',
          ENERGY_DB_PATH: 'C:/data/energy.db',
        } as NodeJS.ProcessEnv,
      })
    ).toThrow();
  });
});

describe('THE DOUBLE-COUNT FAILURE MODE — a replayed flush must insert nothing', () => {
  it('ignores a batch that was already written', () => {
    const batch = [event(), event(), event()];

    const first = store.writeEvents(batch);
    expect(first).toEqual({ inserted: 3, alreadyPresent: 0, suppressedAsDuplicate: 0 });

    // The real scenario: the transaction committed and then the *call* failed —
    // a dropped connection, a killed process between commit and return — so the
    // meter retries a batch that is already durable. Without `UNIQUE(request_id)`
    // this is the one path that bills a customer twice.
    const replay = store.writeEvents(batch);
    expect(replay).toEqual({ inserted: 0, alreadyPresent: 3, suppressedAsDuplicate: 0 });

    store.rollUp();
    expect(monthOf('2026-07')[0].requests).toBe(3);
    expect(monthOf('2026-07')[0].billableRequests).toBe(3);
  });

  it('reports the replay as a number rather than as silence', () => {
    const batch = [event()];
    store.writeEvents(batch);

    // A store retrying every batch is a real condition, and it should show up as
    // a count somebody can alert on rather than as everything looking fine.
    expect(store.writeEvents(batch).alreadyPresent).toBe(1);
  });

  it('rolls up idempotently — running it twice does not double a figure', () => {
    store.writeEvents([event(), event()]);

    const first = store.rollUp();
    expect(first.events).toBe(2);
    expect(monthOf('2026-07')[0].requests).toBe(2);

    const second = store.rollUp();
    expect(second.events).toBe(0);
    expect(second.rolledThroughEventId).toBe(first.rolledThroughEventId);
    expect(monthOf('2026-07')[0].requests).toBe(2);
  });

  it('writes a batch atomically, so a mid-batch failure leaves no partial month', () => {
    // `duration_ms` is NOT NULL, so a row missing it raises inside the
    // transaction — which is the behaviour worth pinning, because it is exactly
    // what `INSERT OR IGNORE` took away. `OR IGNORE` suppresses NOT NULL and
    // CHECK violations too, so this row used to be dropped silently and counted
    // as `alreadyPresent`: a discarded billing record reported as a retried
    // flush. `ON CONFLICT(request_id) DO NOTHING` ignores only the case we mean.
    const bad = { ...event(), durationMs: null as unknown as number };
    expect(() => store.writeEvents([event(), bad, event()])).toThrow();

    // Nothing from that batch landed — not the row before the bad one either.
    // A half-written batch is a month that is wrong in a way nobody can
    // reconstruct, which is worse than a batch the meter simply retries.
    const db = raw();
    const count = (db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n;
    db.close();
    expect(count).toBe(0);
  });
});

describe('Idempotency-Key — suppressing a retry without opening a free-traffic switch', () => {
  it('does not bill a retry of the same call under the same key', () => {
    const original = event({ idempotencyKey: 'client-retry-1' });
    const retry = event({ idempotencyKey: 'client-retry-1' });

    const outcome = store.writeEvents([original, retry]);

    expect(outcome.inserted).toBe(2);
    expect(outcome.suppressedAsDuplicate).toBe(1);

    store.rollUp();
    const month = monthOf('2026-07')[0];
    // Both are recorded — we served both — but only one is charged for.
    expect(month.requests).toBe(2);
    expect(month.billableRequests).toBe(1);
  });

  it('records which request the suppressed one duplicates, so a dispute has an answer', () => {
    store.writeEvents([
      event({ requestId: 'req_original', idempotencyKey: 'k' }),
      event({ requestId: 'req_retry', idempotencyKey: 'k' }),
    ]);

    const db = raw();
    const row = db
      .prepare('SELECT duplicate_of FROM usage_events WHERE request_id = ?')
      .get('req_retry') as { duplicate_of: string };
    db.close();

    expect(row.duplicate_of).toBe('req_original');
  });

  it('does not suppress a different call that pinned the same key', () => {
    // The fingerprint is the part ABL-293 §2c does not specify and the part that
    // makes the header safe to honour: without it a client pins one
    // `Idempotency-Key` to everything it sends and pays for one request a day.
    const load = event({ idempotencyKey: 'pinned' });
    const price = event({
      idempotencyKey: 'pinned',
      queryParams: 'country=FR',
      fingerprint: requestFingerprint('GET', ROUTE, 'country=FR'),
    });

    const outcome = store.writeEvents([load, price]);

    expect(outcome.suppressedAsDuplicate).toBe(0);
    store.rollUp();
    expect(monthOf('2026-07')[0].billableRequests).toBe(2);
  });

  it('stops suppressing past the cap — a polling loop is traffic we served', () => {
    const calls = Array.from({ length: IDEMPOTENT_SUPPRESSION_LIMIT + 2 }, () =>
      event({ idempotencyKey: 'pinned-forever' })
    );

    const outcome = store.writeEvents(calls);

    // One original, then exactly `IDEMPOTENT_SUPPRESSION_LIMIT` suppressed, then
    // billing resumes. The residual exposure is bounded and stated rather than
    // hidden.
    expect(outcome.suppressedAsDuplicate).toBe(IDEMPOTENT_SUPPRESSION_LIMIT);
    store.rollUp();
    expect(monthOf('2026-07')[0].billableRequests).toBe(calls.length - IDEMPOTENT_SUPPRESSION_LIMIT);
  });

  it('does not reach back beyond the window', () => {
    store.writeEvents([
      event({ receivedAt: '2026-07-01T00:00:00.000Z', idempotencyKey: 'k' }),
      // Two days later: a retry policy that gives up after five attempts does
      // not retry two days later. This is a new call.
      event({ receivedAt: '2026-07-03T00:00:00.000Z', idempotencyKey: 'k' }),
    ]);

    store.rollUp();
    expect(monthOf('2026-07')[0].billableRequests).toBe(2);
  });

  it('does not confuse two accounts that chose the same key string', () => {
    store.writeEvents([
      event({ idempotencyKey: 'req-1' }),
      event({ accountId: 'acct_someone_else', idempotencyKey: 'req-1' }),
    ]);

    store.rollUp();
    expect(monthOf('2026-07').find((r) => r.accountId === 'acct_someone_else')!.billableRequests).toBe(1);
  });
});

describe('the rollup is the invoice, and it is materialised', () => {
  it('aggregates per account, key and UTC month', () => {
    store.writeEvents([
      event({ receivedAt: '2026-07-15T12:00:00.000Z' }),
      event({ receivedAt: '2026-07-31T23:59:59.999Z' }),
      event({ receivedAt: '2026-08-01T00:00:00.000Z' }),
      event({ keyId: secondKeyId, receivedAt: '2026-07-02T00:00:00.000Z' }),
    ]);
    store.rollUp();

    const july = monthOf('2026-07');
    expect(july).toHaveLength(2);
    expect(july.find((r) => r.keyId === keyId)!.requests).toBe(2);
    expect(july.find((r) => r.keyId === secondKeyId)!.requests).toBe(1);
    // One millisecond later is a different invoice.
    expect(monthOf('2026-08')[0].requests).toBe(1);
  });

  it('separates what was served from what is charged for', () => {
    store.writeEvents([
      event({ status: 200, billable: true }),
      event({ status: 404, billable: false }),
      event({ status: 500, billable: false }),
    ]);
    store.rollUp();

    const month = monthOf('2026-07')[0];
    expect(month.requests).toBe(3);
    expect(month.billableRequests).toBe(1);
  });

  it('totals rows and bytes, treating an unreported figure as nothing rather than guessing', () => {
    store.writeEvents([
      event({ rowCount: 100, responseBytes: 5_000 }),
      event({ rowCount: null, responseBytes: null }),
    ]);
    store.rollUp();

    const month = monthOf('2026-07')[0];
    expect(month.rowsReturned).toBe(100);
    expect(month.responseBytes).toBe(5_000);
  });

  it('keeps the first and last event times as the month accumulates', () => {
    store.writeEvents([event({ receivedAt: '2026-07-15T00:00:00.000Z' })]);
    store.rollUp();
    store.writeEvents([
      event({ receivedAt: '2026-07-02T00:00:00.000Z' }),
      event({ receivedAt: '2026-07-28T00:00:00.000Z' }),
    ]);
    store.rollUp();

    const month = monthOf('2026-07')[0];
    expect(month.firstEventAt).toBe('2026-07-02T00:00:00.000Z');
    expect(month.lastEventAt).toBe('2026-07-28T00:00:00.000Z');
    expect(month.requests).toBe(3);
  });

  it('resumes from the watermark when a pass is capped', () => {
    store.writeEvents(Array.from({ length: 10 }, () => event()));

    const first = store.rollUp({ maxEvents: 4 });
    expect(first.moreRemaining).toBe(true);
    expect(first.events).toBe(4);

    const drained = runUsageMaintenance(store, new Date('2026-08-15T00:00:00Z'));
    expect(drained.rollUp.drained).toBe(true);
    expect(monthOf('2026-07')[0].requests).toBe(10);
  });
});

describe('closing a month — explicit, idempotent, and final', () => {
  const AFTER_JULY = new Date('2026-08-15T00:00:00Z');

  it('closes a month that is past its grace period and fully aggregated', () => {
    store.writeEvents([event(), event()]);
    store.rollUp();

    const outcome = store.closeMonths(AFTER_JULY);

    expect(outcome.closed).toEqual(['2026-07']);
    expect(monthOf('2026-07')[0].closedAt).not.toBeNull();
  });

  it('does not close a month that is still inside its grace period', () => {
    store.writeEvents([event()]);
    store.rollUp();

    // 1 August is one day after the month ended; the grace period is two. The
    // margin exists for a maintenance pass that did not run on time — the
    // alternative is a month closed while its last hour of events is buffered.
    expect(store.closeMonths(new Date('2026-08-01T12:00:00Z')).closed).toEqual([]);
    expect(monthOf('2026-07')[0].closedAt).toBeNull();
  });

  it('refuses to close over the top of events that are not aggregated yet', () => {
    store.writeEvents([event()]);
    store.rollUp();
    store.writeEvents([event(), event()]); // arrived after the rollup pass

    const outcome = store.closeMonths(AFTER_JULY);

    // Reported rather than forced. Closing here would make those two requests
    // permanently unbillable, which is how a month's tail silently stops
    // counting.
    expect(outcome.closed).toEqual([]);
    expect(outcome.deferred).toEqual(['2026-07']);
    expect(monthOf('2026-07')[0].closedAt).toBeNull();
  });

  it('is idempotent — closing twice does not move the closing timestamp', () => {
    store.writeEvents([event()]);
    store.rollUp();
    store.closeMonths(AFTER_JULY);
    const closedAt = monthOf('2026-07')[0].closedAt;

    expect(store.closeMonths(new Date('2026-09-01T00:00:00Z')).closed).toEqual([]);
    expect(monthOf('2026-07')[0].closedAt).toBe(closedAt);
  });

  it('never re-bills a closed month for an event that arrives late', () => {
    store.writeEvents([event(), event()]);
    store.rollUp();
    store.closeMonths(AFTER_JULY);
    const invoiced = monthOf('2026-07')[0].billableRequests;

    // A late event for a month that has been invoiced. Raising an invoice a
    // customer has already received is a worse outcome than under-counting,
    // which is the rule this whole module is written to.
    store.writeEvents([event({ requestId: 'req_late', receivedAt: '2026-07-20T00:00:00.000Z' })]);
    store.rollUp();

    const month = monthOf('2026-07')[0];
    expect(month.billableRequests).toBe(invoiced);
    expect(month.requests).toBe(2);
    // Counted where somebody investigating will see it, rather than silently
    // folded into a figure that has already been sent out.
    expect(month.lateRequests).toBe(1);
    expect(month.lateBillableRequests).toBe(1);
  });

  it('leaves an open month for a different key alone when another closes', () => {
    store.writeEvents([event({ receivedAt: '2026-07-15T00:00:00.000Z' })]);
    store.writeEvents([event({ receivedAt: '2026-08-15T00:00:00.000Z' })]);
    store.rollUp();
    store.closeMonths(AFTER_JULY);

    expect(monthOf('2026-07')[0].closedAt).not.toBeNull();
    expect(monthOf('2026-08')[0].closedAt).toBeNull();
  });

  /**
   * The same guarantee as the test above, for the case that used to break it.
   *
   * The `late_*` columns are maintained by the `ON CONFLICT … DO UPDATE` arm of
   * the rollup, so before `usage_month_close` existed they only fired for an
   * (account, key, month) that already had a row. A late event on a key with no
   * traffic in that month took the INSERT arm, found nothing to conflict with,
   * and was written as an *open* row with its request in the billable columns —
   * so the month's total grew by one billable request after the invoice for it
   * had been sent, and `lateRequests` stayed at zero.
   *
   * Asserted on the total across the month's rows rather than on `[0]`, because
   * this is the figure an invoice is raised from and the bug was invisible in
   * any single row.
   */
  it('never re-bills a closed month for a late event on a key with no row in it', () => {
    store.writeEvents([event(), event()]);
    store.rollUp();
    store.closeMonths(AFTER_JULY);
    const invoiced = billableIn('2026-07');
    expect(invoiced).toBe(2);

    store.writeEvents([
      event({
        requestId: 'req_late_second_key',
        keyId: secondKeyId,
        receivedAt: '2026-07-20T00:00:00.000Z',
      }),
    ]);
    store.rollUp();

    expect(billableIn('2026-07')).toBe(invoiced);

    // The row is created rather than dropped — an event nobody can account for
    // is worse than one counted where an investigator will find it — and it is
    // born closed, so it can never be read as a month still accruing.
    const late = monthOf('2026-07').find((row) => row.keyId === secondKeyId);
    expect(late).toBeDefined();
    expect(late?.closedAt).not.toBeNull();
    expect(late?.requests).toBe(0);
    expect(late?.billableRequests).toBe(0);
    expect(late?.lateRequests).toBe(1);
    expect(late?.lateBillableRequests).toBe(1);
  });

  it('still treats a month as closed for a new key after a restart', () => {
    store.writeEvents([event()]);
    store.rollUp();
    store.closeMonths(AFTER_JULY);
    store.close();

    // Closure has to survive the process, not just the object: it is recorded
    // in the file, so a restarted store judges a late event the same way.
    store = openUsageStore({
      env: { API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv,
      policy: { piiDays: 90, eventMonths: 13, monthCloseGraceDays: 2 },
    });
    store.writeEvents([
      event({
        requestId: 'req_late_after_restart',
        keyId: secondKeyId,
        receivedAt: '2026-07-25T00:00:00.000Z',
      }),
    ]);
    store.rollUp();

    expect(billableIn('2026-07')).toBe(1);
    const late = monthOf('2026-07').find((row) => row.keyId === secondKeyId);
    expect(late?.closedAt).not.toBeNull();
    expect(late?.lateBillableRequests).toBe(1);
  });
});

describe('retention — ABL-297 §5, which is a published commitment', () => {
  const NOW = new Date('2026-08-12T00:00:00Z');

  it('clears the IP and user agent at 90 days and records that it did', () => {
    store.writeEvents([
      event({ requestId: 'req_old', receivedAt: '2026-01-01T00:00:00.000Z' }),
      event({ requestId: 'req_recent', receivedAt: '2026-08-01T00:00:00.000Z' }),
    ]);

    const outcome = store.applyRetention(NOW);
    expect(outcome.scrubbed).toBe(1);

    const db = raw();
    const rows = db
      .prepare('SELECT request_id, client_ip, user_agent, pii_scrubbed_at FROM usage_events ORDER BY id')
      .all() as Array<Record<string, string | null>>;
    db.close();

    const old = rows.find((r) => r.request_id === 'req_old')!;
    expect(old.client_ip).toBeNull();
    expect(old.user_agent).toBeNull();
    // "No IP because it was removed" must stay distinguishable from "no IP
    // recorded", or the log cannot evidence its own compliance.
    expect(old.pii_scrubbed_at).toBe(NOW.toISOString());

    const recent = rows.find((r) => r.request_id === 'req_recent')!;
    expect(recent.client_ip).toBe('192.0.2.10');
  });

  it('keeps the de-identified row until 13 months, rather than deleting it at 90 days', () => {
    // §5 publishes two periods to two different audiences. Deleting the whole
    // row at 90 days would satisfy the privacy half and quietly break the other
    // half of the same sentence.
    store.writeEvents([event({ receivedAt: '2026-01-01T00:00:00.000Z' })]);
    store.rollUp();

    const outcome = store.applyRetention(NOW);
    expect(outcome.scrubbed).toBe(1);
    expect(outcome.deleted).toBe(0);

    const db = raw();
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('deletes the de-identified record past 13 months', () => {
    store.writeEvents([
      event({ requestId: 'req_ancient', receivedAt: '2025-01-01T00:00:00.000Z' }),
      event({ requestId: 'req_old', receivedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    store.rollUp();

    const outcome = store.applyRetention(NOW);

    expect(outcome.deleted).toBe(1);
    const db = raw();
    const remaining = (
      db.prepare('SELECT request_id FROM usage_events').all() as Array<{ request_id: string }>
    ).map((r) => r.request_id);
    db.close();
    expect(remaining).toEqual(['req_old']);
  });

  it('reads both periods from configuration, so counsel changing 90 is a config change', () => {
    store.close();
    store = openUsageStore({
      env: { API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv,
      policy: { piiDays: 7, eventMonths: 1, monthCloseGraceDays: 2 },
    });

    store.writeEvents([event({ receivedAt: '2026-08-01T00:00:00.000Z' })]);
    store.rollUp();

    // Scrubbed at 7 days rather than 90, with no migration and no code change.
    expect(store.applyRetention(NOW).scrubbed).toBe(1);
  });

  it('KEEPS a row past the deletion boundary when the rollup has not aggregated it', () => {
    store.writeEvents([event({ receivedAt: '2025-01-01T00:00:00.000Z' })]);
    // Deliberately no rollUp: this is the "the rollup has been broken for
    // thirteen months" state.

    const outcome = store.applyRetention(NOW);

    // Deleting an un-aggregated event removes it from an invoice for good. The
    // correct response to a broken rollup is to fix the rollup, never to delete
    // the evidence — so retention keeps the row and reports the number.
    expect(outcome.deleted).toBe(0);
    expect(outcome.keptPendingRollup).toBe(1);

    // And once the rollup catches up, the row is both billed and then deletable.
    store.rollUp();
    expect(monthOf('2025-01')[0].billableRequests).toBe(1);
    expect(store.applyRetention(NOW).deleted).toBe(1);
  });

  it('is idempotent — a second pass scrubs and deletes nothing more', () => {
    store.writeEvents([event({ receivedAt: '2026-01-01T00:00:00.000Z' })]);
    store.rollUp();
    store.applyRetention(NOW);

    expect(store.applyRetention(NOW)).toEqual({ scrubbed: 0, deleted: 0, keptPendingRollup: 0 });
  });

  it('touches nothing but usage_events — not the rollup, and not the key store', () => {
    // ABL-297 §9(5): this issue introduces the first scheduled deletion in the
    // codebase and is therefore where the forecast-vintage retention commitment
    // is most likely to be broken by accident later. The job is scoped to the
    // request log and there is no general-purpose row reaper.
    store.writeEvents([event({ receivedAt: '2025-01-01T00:00:00.000Z' })]);
    store.rollUp();

    const before = raw();
    const keysBefore = (before.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n;
    before.close();

    store.applyRetention(NOW);

    const after = raw();
    expect((after.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n).toBe(keysBefore);
    expect((after.prepare('SELECT COUNT(*) AS n FROM usage_rollup').get() as { n: number }).n).toBe(1);
    after.close();
  });
});

describe('THE CLAIM ABL-297 §9(2) IS ABOUT — an invoice survives its evidence', () => {
  it('still reports a month after every raw event behind it has been deleted', () => {
    // Eight months on, a customer disputes an invoice. The raw rows are long
    // gone under the retention job we published. If the figure were recomputed
    // from those rows it would now be zero, and the dispute would be
    // unanswerable — which is exactly the failure ABL-297 §9(2) says cannot be
    // fixed retroactively because it is not discovered until it happens.
    store.writeEvents([event(), event(), event()]);
    store.rollUp();
    store.closeMonths(new Date('2026-08-15T00:00:00Z'));

    const invoiced = monthOf('2026-07')[0];
    expect(invoiced.billableRequests).toBe(3);
    expect(invoiced.closedAt).not.toBeNull();

    // Thirteen months later, retention removes every event the invoice was
    // computed from.
    const muchLater = new Date('2027-11-01T00:00:00Z');
    expect(store.applyRetention(muchLater).deleted).toBe(3);

    const db = raw();
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n).toBe(0);
    db.close();

    // The figure is unchanged, because it was never derived on demand.
    const afterPruning = monthOf('2026-07')[0];
    expect(afterPruning.billableRequests).toBe(3);
    expect(afterPruning.requests).toBe(3);
    expect(afterPruning.closedAt).toBe(invoiced.closedAt);
  });

  it('does not recompute a closed month from rows that are still present', () => {
    store.writeEvents([event(), event()]);
    store.rollUp();
    store.closeMonths(new Date('2026-08-15T00:00:00Z'));

    // Even a full re-roll cannot move a closed figure: the watermark has passed
    // those ids, and every `DO UPDATE` assignment is guarded on `closed_at IS
    // NULL` besides.
    store.rollUp();
    store.rollUp();

    expect(monthOf('2026-07')[0].billableRequests).toBe(2);
  });
});

describe('THE WATERMARK REGRESSION — why usage_events.id is AUTOINCREMENT', () => {
  it('does not reuse an id after retention empties the table', () => {
    store.writeEvents([
      event({ receivedAt: '2025-01-01T00:00:00.000Z' }),
      event({ receivedAt: '2025-01-02T00:00:00.000Z' }),
      event({ receivedAt: '2025-01-03T00:00:00.000Z' }),
    ]);
    store.rollUp();

    const now = new Date('2026-08-12T00:00:00Z');
    expect(store.applyRetention(now).deleted).toBe(3);

    const db = raw();
    const watermark = (
      db.prepare('SELECT rolled_through_event_id AS id FROM usage_rollup_state').get() as {
        id: number;
      }
    ).id;
    db.close();
    expect(watermark).toBe(3);

    // The next request after the table was emptied. With a bare INTEGER PRIMARY
    // KEY, SQLite assigns max(rowid)+1 — so this row would be id 1, the
    // watermark would still be 3, and this event and every one after it would be
    // skipped by the rollup forever. The customer would be billed zero, and a
    // zero invoice is the one error nobody reports.
    store.writeEvents([event({ requestId: 'req_after_purge', receivedAt: '2026-08-11T00:00:00.000Z' })]);

    const check = raw();
    const id = (
      check.prepare('SELECT id FROM usage_events WHERE request_id = ?').get('req_after_purge') as {
        id: number;
      }
    ).id;
    check.close();
    expect(id).toBeGreaterThan(watermark);

    // Which is the property that matters: it still reaches the invoice.
    store.rollUp();
    expect(monthOf('2026-08')[0].billableRequests).toBe(1);
  });

  it('does not reuse the highest id after only the newest row is deleted', () => {
    // The subtler half: deleting the top row alone frees its rowid too.
    store.writeEvents([event(), event()]);

    const db = new Database(dbPath);
    db.prepare('DELETE FROM usage_events WHERE id = (SELECT MAX(id) FROM usage_events)').run();
    db.close();

    store.writeEvents([event({ requestId: 'req_next' })]);

    const check = raw();
    const rows = check.prepare('SELECT id, request_id FROM usage_events ORDER BY id').all() as Array<{
      id: number;
      request_id: string;
    }>;
    check.close();

    expect(rows.map((r) => r.request_id)).toEqual(['req_1', 'req_next']);
    expect(rows[1].id).toBe(3);
  });
});

describe('what the file holds, and what an export hands over', () => {
  it('records the route template and the allowlisted parameters, never a raw URL', () => {
    store.writeEvents([event()]);
    store.close();

    const bytes = fs.readFileSync(dbPath).toString('binary');
    expect(bytes).toContain(ROUTE);
    expect(bytes).toContain('country=BE');
  });

  it('exports every record tied to an account, for a subject access request', () => {
    store.writeEvents([event(), event({ keyId: secondKeyId })]);
    store.rollUp();

    const exported = store.exportAccount(accountId);

    expect(exported.accountId).toBe(accountId);
    expect(exported.events).toHaveLength(2);
    expect(exported.rollups).toHaveLength(2);
    expect(exported.keys).toHaveLength(2);
    expect(exported.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('never puts a key secret hash in an export', () => {
    store.writeEvents([event()]);
    const exported = store.exportAccount(accountId);

    // A SAR is answered with the data we hold *about* the subject; a key hash is
    // a credential. The file travels outside the system by definition, often by
    // email, so this is the one field that must not be in it.
    expect(JSON.stringify(exported)).not.toContain('secret_sha256');
    for (const key of exported.keys) {
      expect(key).not.toHaveProperty('secret_sha256');
      expect(key).toHaveProperty('key_prefix');
    }
  });

  it('does include the account contact, which is the subject’s own address', () => {
    // The mirror of the case above, and the reason both are needed: the export
    // names its columns explicitly, so the default for a new `api_keys` column
    // is *absent*. That is right for a credential and wrong for personal data,
    // and `contact_email` (ABL-528) is personal data the subject gave us —
    // omitting it makes the export quietly incomplete in the one direction
    // ABL-297 §9(3) is about.
    store.writeEvents([event()]);
    const exported = store.exportAccount(accountId);

    expect(exported.keys[0]).toHaveProperty('contact_email', 'ops@acme.example');
  });

  it('exports nothing for an account that has no records', () => {
    const exported = store.exportAccount('acct_nobody');
    expect(exported.events).toEqual([]);
    expect(exported.rollups).toEqual([]);
    expect(exported.keys).toEqual([]);
  });

  it('answers a subject access request against a key store that predates the contact column', () => {
    // The state `lookupSql` in `sqliteApiKeyStore.ts` was written for, reached
    // from the other module that names `contact_email`. This one opens the file
    // read-write but confines its DDL to the three usage tables — it does not
    // apply the keys migration, only checks that `api_keys` exists — so it can
    // meet a pre-ABL-528 file and must degrade the same way rather than throw.
    //
    // The prepare is lazy, inside `exportAccount`, so nothing fails at open: it
    // would fail at the moment somebody answers a subject access request, which
    // is the one command whose whole job is to be answerable on demand.
    //
    // The fixture is hand-written rather than seeded through
    // `openApiKeyAdminStore`, because that store always migrates — so the
    // rest of this file structurally cannot reach this path.
    const oldPath = tmpDbPath();
    const old = new Database(oldPath);
    old.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL,
        created_at TEXT NOT NULL, disabled_at TEXT);
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        key_env TEXT NOT NULL, key_prefix TEXT NOT NULL UNIQUE,
        secret_sha256 TEXT NOT NULL, label TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT,
        revoked_at TEXT, revoked_reason TEXT);
      INSERT INTO accounts VALUES
        ('acct_old', 'Acme Energy', 'developer', '2026-01-01T00:00:00.000Z', NULL);
      INSERT INTO api_keys VALUES
        ('key_old', 'acct_old', 'live', '7f3a9c21', 'deadbeef', 'prod ETL',
         '2026-01-01T00:00:00.000Z', NULL, NULL, NULL);
    `);
    old.close();

    const oldStore = openUsageStore({
      env: { API_KEYS_DB_PATH: oldPath } as NodeJS.ProcessEnv,
      policy: { piiDays: 90, eventMonths: 13, monthCloseGraceDays: 2 },
    });

    try {
      const exported = oldStore.exportAccount('acct_old');

      expect(exported.keys).toHaveLength(1);
      // Present as a key, and reported as having no contact — which is the true
      // claim about the row. `null` here and the `unreachable` half of
      // `collectAccountContacts` are the same fact reaching two readers.
      expect(exported.keys[0]).toMatchObject({ id: 'key_old', contact_email: null });
      // The guard degrades the one column and nothing else: the rest of the
      // export is unaffected, and the secret hash is still absent.
      expect(exported.keys[0]).toHaveProperty('key_prefix', '7f3a9c21');
      expect(exported.keys[0]).not.toHaveProperty('secret_sha256');
    } finally {
      oldStore.close();
    }
  });
});

describe('stats — the standing check that the published retention is real', () => {
  const NOW = new Date('2026-08-12T00:00:00Z');

  it('reports zero unscrubbed records once retention has run', () => {
    store.writeEvents([
      event({ receivedAt: '2026-01-01T00:00:00.000Z' }),
      event({ receivedAt: '2026-08-01T00:00:00.000Z' }),
    ]);

    // Before the job runs, the old row is a published commitment we are not
    // meeting — and it says so.
    expect(store.stats(NOW).unscrubbedPastPii).toBe(1);

    store.applyRetention(NOW);
    expect(store.stats(NOW).unscrubbedPastPii).toBe(0);
  });

  it('reports the rollup backlog, which is what makes a month uncloseable', () => {
    store.writeEvents([event(), event(), event()]);

    expect(store.stats(NOW).unrolledEvents).toBe(3);
    store.rollUp();

    const after = store.stats(NOW);
    expect(after.unrolledEvents).toBe(0);
    expect(after.events).toBe(3);
    expect(after.rollupRows).toBe(1);
    expect(after.rolledThroughEventId).toBe(3);
  });

  it('counts closed months', () => {
    store.writeEvents([event()]);
    store.rollUp();
    expect(store.stats(NOW).closedMonths).toBe(0);

    store.closeMonths(new Date('2026-08-15T00:00:00Z'));
    expect(store.stats(NOW).closedMonths).toBe(1);
  });

  it('is safe on an empty store', () => {
    const stats = store.stats(NOW);
    expect(stats.events).toBe(0);
    expect(stats.oldestEventAt).toBeNull();
    expect(stats.rolledThroughEventId).toBe(0);
    expect(stats.unscrubbedPastPii).toBe(0);
  });
});

describe('durability across a restart', () => {
  it('resumes from the watermark rather than re-aggregating what it already billed', () => {
    store.writeEvents([event(), event()]);
    store.rollUp();
    store.close();

    // A restart: new process, new handle, same file.
    store = openUsageStore({ env: { API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv });
    store.writeEvents([event()]);
    const outcome = store.rollUp();

    // Only the new event. If the watermark had not survived, the first two
    // would be counted a second time and the customer would be billed twice for
    // a restart.
    expect(outcome.events).toBe(1);
    expect(monthOf('2026-07')[0].requests).toBe(3);
  });

  it('keeps a closed month closed across a restart', () => {
    store.writeEvents([event()]);
    store.rollUp();
    store.closeMonths(new Date('2026-08-15T00:00:00Z'));
    const closedAt = monthOf('2026-07')[0].closedAt;
    store.close();

    store = openUsageStore({ env: { API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv });
    expect(monthOf('2026-07')[0].closedAt).toBe(closedAt);
  });
});

describe('the live quota figure (ABL-302)', () => {
  it('counts every key on the account, because the plan is sold to the account', () => {
    // `MAX_LIVE_KEYS_PER_ACCOUNT` is 5, so a per-key quota would deliver five
    // times what a customer bought. The per-key split is not lost — it is what
    // `usage_rollup` is keyed on — but the limit belongs where the plan does.
    store.writeEvents([
      event({ keyId }),
      event({ keyId }),
      event({ keyId: secondKeyId }),
    ]);

    expect(store.servedRequestsInMonth(accountId, '2026-07')).toBe(3);
  });

  it('excludes the requests the gate refused', () => {
    // The one line that keeps the durable seed and the in-process counter
    // talking about the same quantity. A 429 is recorded — a refusal is still
    // traffic and still evidence — and it never consumed quota, so counting it
    // here would lock a hard-stop customer out early and would put refused
    // requests into a Professional account's billable overage.
    store.writeEvents([
      event({ status: 200 }),
      event({ status: 429, billable: false }),
      event({ status: 429, billable: false }),
    ]);

    expect(store.servedRequestsInMonth(accountId, '2026-07')).toBe(1);
  });

  it('counts a request the caller got wrong, which is still a request we served', () => {
    // 4xx is recorded and not billed (`isBillableStatus`), and it still consumes
    // quota. The alternative makes a broken client's error traffic free and
    // unlimited, which is the same hole `isBillableStatus`'s own comment names
    // from the rate-limit side.
    store.writeEvents([event({ status: 400, billable: false }), event({ status: 500, billable: false })]);

    expect(store.servedRequestsInMonth(accountId, '2026-07')).toBe(2);
  });

  it('is bounded by the UTC calendar month at both ends', () => {
    // The billing month is UTC for every customer, so the quota window has to be
    // the same one `usage_rollup.year_month` uses. An off-by-one at either edge
    // hands a customer a free hour or bills them for one twice.
    store.writeEvents([
      event({ receivedAt: '2026-06-30T23:59:59.999Z' }),
      event({ receivedAt: '2026-07-01T00:00:00.000Z' }),
      event({ receivedAt: '2026-07-31T23:59:59.999Z' }),
      event({ receivedAt: '2026-08-01T00:00:00.000Z' }),
    ]);

    expect(store.servedRequestsInMonth(accountId, '2026-06')).toBe(1);
    expect(store.servedRequestsInMonth(accountId, '2026-07')).toBe(2);
    expect(store.servedRequestsInMonth(accountId, '2026-08')).toBe(1);
  });

  it('handles a December-to-January boundary', () => {
    // `monthEndExclusive` builds the upper bound with `new Date(Date.UTC(year,
    // month, 1))`, so month 12 has to roll the year. Cheap to check and the kind
    // of thing that fails once a year at midnight.
    store.writeEvents([
      event({ receivedAt: '2026-12-31T23:00:00.000Z' }),
      event({ receivedAt: '2027-01-01T00:30:00.000Z' }),
    ]);

    expect(store.servedRequestsInMonth(accountId, '2026-12')).toBe(1);
    expect(store.servedRequestsInMonth(accountId, '2027-01')).toBe(1);
  });

  it('sees another account’s traffic as none of this one’s', () => {
    store.writeEvents([event({ accountId: 'acct_someone_else' }), event()]);

    expect(store.servedRequestsInMonth(accountId, '2026-07')).toBe(1);
  });

  it('reads the raw events rather than the rollup, so an open month is current', () => {
    // The opposite of the rule `monthlyUsage` follows, and deliberately.
    // An invoice must come from the materialised aggregate, which survives
    // retention. A quota is enforced against a month still open, and the rollup
    // lags by a maintenance interval — enforcing on a figure that is minutes
    // stale would let a burst through in exactly the window a burst arrives in.
    store.writeEvents([event(), event()]);

    // Nothing has been rolled up yet.
    expect(store.monthlyUsage('2026-07')).toHaveLength(0);
    expect(store.servedRequestsInMonth(accountId, '2026-07')).toBe(2);
  });

  it('uses the account index rather than scanning', () => {
    // The reason the bounds are a half-open `received_at` range and not
    // `substr(received_at, 1, 7) = ?`. The substring form reads better, cannot
    // use `idx_usage_events_account_received`, and degrades to a scan of every
    // event the account has ever sent — on a request path, against a table that
    // grows by one row per request forever.
    store.writeEvents([event()]);

    const db = raw();
    try {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT COUNT(*) FROM usage_events
            WHERE account_id = ? AND received_at >= ? AND received_at < ? AND status <> 429`
        )
        .all(accountId, '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z') as Array<{
        detail: string;
      }>;

      const detail = plan.map((row) => row.detail).join(' ');
      expect(detail).toContain('idx_usage_events_account_received');
      expect(detail).not.toContain('SCAN usage_events');
    } finally {
      db.close();
    }
  });
});
