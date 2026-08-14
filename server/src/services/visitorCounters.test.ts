import { describe, it, expect } from 'vitest';
import {
  createVisitorCounterStore,
  utcDayKey,
  DISTINCT_CLIENT_CAP,
  WINDOW_DAYS,
} from './visitorCounters.js';

const at = (iso: string) => new Date(iso);
const DAY_MS = 24 * 60 * 60 * 1000;

describe('utcDayKey', () => {
  it('buckets by UTC, not by the host\'s local day', () => {
    // Brussels is UTC+2 in August. 23:30 UTC on the 11th is 01:30 local on the
    // 12th; a local-day bucket would move counts between days depending on
    // where the box is, and shift again at the DST step.
    expect(utcDayKey(at('2026-08-11T23:30:00Z'))).toBe('2026-08-11');
    expect(utcDayKey(at('2026-08-12T00:10:00Z'))).toBe('2026-08-12');
  });
});

describe('visitor counters — lanes', () => {
  it('starts at zero in every lane rather than undefined', () => {
    const store = createVisitorCounterStore(at('2026-08-12T09:00:00Z'));
    const snap = store.snapshot(at('2026-08-12T10:00:00Z'));

    expect(snap.today).toEqual({ page: 0, api: 0, asset: 0, automated: 0 });
    expect(snap.window).toEqual({ page: 0, api: 0, asset: 0, automated: 0 });
    expect(snap.distinctClientsToday).toBe(0);
  });

  it('keeps each lane separate and never folds automated traffic into the others', () => {
    const store = createVisitorCounterStore(at('2026-08-12T09:00:00Z'));
    const now = at('2026-08-12T10:00:00Z');

    store.record('page', 'a', now);
    store.record('page', 'a', now);
    store.record('api', 'a', now);
    store.record('asset', 'a', now);
    for (let i = 0; i < 500; i += 1) store.record('automated', null, now);

    expect(store.snapshot(now).today).toEqual({ page: 2, api: 1, asset: 1, automated: 500 });
  });

  it('reports the day the `today` figures belong to', () => {
    const store = createVisitorCounterStore(at('2026-08-12T09:00:00Z'));
    expect(store.snapshot(at('2026-08-12T23:59:59Z')).day).toBe('2026-08-12');
  });
});

describe('visitor counters — the rolling window', () => {
  it('sums exactly the last seven UTC days, today inclusive', () => {
    const store = createVisitorCounterStore(at('2026-08-01T00:00:00Z'));
    const today = at('2026-08-12T12:00:00Z');

    // One page view on each of the last ten days.
    for (let back = 0; back < 10; back += 1) {
      store.record('page', `c${back}`, new Date(today.getTime() - back * DAY_MS));
    }

    expect(store.snapshot(today).window.page).toBe(WINDOW_DAYS);
    expect(store.snapshot(today).today.page).toBe(1);
  });

  it('excludes the day that just fell out of the window', () => {
    const store = createVisitorCounterStore(at('2026-08-01T00:00:00Z'));
    const today = at('2026-08-12T12:00:00Z');

    store.record('page', 'c', new Date(today.getTime() - 6 * DAY_MS)); // oldest day still in
    store.record('page', 'c', new Date(today.getTime() - 7 * DAY_MS)); // one day too old

    expect(store.snapshot(today).window.page).toBe(1);
  });

  it('drops buckets beyond the retention horizon instead of growing forever', () => {
    const store = createVisitorCounterStore(at('2026-01-01T00:00:00Z'));
    const start = at('2026-01-01T12:00:00Z');

    for (let day = 0; day < 60; day += 1) {
      store.record('page', 'c', new Date(start.getTime() + day * DAY_MS));
    }

    const last = new Date(start.getTime() + 59 * DAY_MS);
    // Still correct for the window it reports — pruning only removes days no
    // snapshot can reach.
    expect(store.snapshot(last).window.page).toBe(WINDOW_DAYS);
  });
});

describe('visitor counters — honesty about coverage', () => {
  it('marks the window incomplete while the process is younger than it', () => {
    const store = createVisitorCounterStore(at('2026-08-12T09:00:00Z'));
    const snap = store.snapshot(at('2026-08-12T10:00:00Z'));

    // A container restarted an hour ago reporting "4 this week" is the
    // confidently-wrong number this issue is built to avoid. The payload has to
    // carry the fact, so the page can say "since 09:00 today" beside it.
    expect(snap.windowComplete).toBe(false);
    expect(snap.windowDaysCovered).toBe(1);
    expect(snap.countingSince).toBe('2026-08-12T09:00:00.000Z');
  });

  it('marks the window complete once the process predates its first midnight', () => {
    const store = createVisitorCounterStore(at('2026-08-05T23:59:00Z'));
    const snap = store.snapshot(at('2026-08-12T10:00:00Z'));

    // The window's first midnight is 2026-08-06T00:00Z; a process that was
    // already up then has observed all seven days.
    expect(snap.windowComplete).toBe(true);
    expect(snap.windowDaysCovered).toBe(WINDOW_DAYS);
  });

  it('counts the days covered as calendar days touched, capped at the window', () => {
    const store = createVisitorCounterStore(at('2026-08-10T20:00:00Z'));
    expect(store.snapshot(at('2026-08-12T10:00:00Z')).windowDaysCovered).toBe(3);
  });

  it('reset restarts the counting clock as well as the buckets', () => {
    const store = createVisitorCounterStore(at('2026-08-01T00:00:00Z'));
    store.record('page', 'c', at('2026-08-12T09:00:00Z'));

    store.reset(at('2026-08-12T11:00:00Z'));
    const snap = store.snapshot(at('2026-08-12T12:00:00Z'));

    expect(snap.today.page).toBe(0);
    expect(snap.countingSince).toBe('2026-08-12T11:00:00.000Z');
    expect(snap.windowComplete).toBe(false);
  });
});

describe('visitor counters — distinct clients', () => {
  it('counts one key once however many requests it makes', () => {
    const store = createVisitorCounterStore(at('2026-08-12T09:00:00Z'));
    const now = at('2026-08-12T10:00:00Z');

    for (let i = 0; i < 40; i += 1) {
      store.record('page', 'same-client', now);
      store.record('api', 'same-client', now);
    }
    store.record('page', 'other-client', now);

    expect(store.snapshot(now).distinctClientsToday).toBe(2);
  });

  it('does not count automated traffic as a client', () => {
    const store = createVisitorCounterStore(at('2026-08-12T09:00:00Z'));
    const now = at('2026-08-12T10:00:00Z');

    // The peer poller has a stable key and hits us every 30s forever. Counted,
    // it would be a permanent phantom visitor on both environments.
    store.record('automated', 'peer-poller', now);
    store.record('automated', 'docker-healthcheck', now);

    expect(store.snapshot(now).distinctClientsToday).toBe(0);
    expect(store.snapshot(now).today.automated).toBe(2);
  });

  it('does not count a request with no client key', () => {
    const store = createVisitorCounterStore(at('2026-08-12T09:00:00Z'));
    const now = at('2026-08-12T10:00:00Z');

    store.record('page', null, now);

    expect(store.snapshot(now).today.page).toBe(1);
    expect(store.snapshot(now).distinctClientsToday).toBe(0);
  });

  it('reports null, not a frozen number, once the per-day cap is reached', () => {
    const store = createVisitorCounterStore(at('2026-08-12T09:00:00Z'));
    const now = at('2026-08-12T10:00:00Z');

    for (let i = 0; i <= DISTINCT_CLIENT_CAP; i += 1) store.record('page', `client-${i}`, now);

    // A count stuck at exactly the cap while traffic keeps arriving is a wrong
    // number. `null` is the house answer for "no longer measurable".
    expect(store.snapshot(now).distinctClientsToday).toBeNull();
    // The lane count is unaffected — that one is still exact.
    expect(store.snapshot(now).today.page).toBe(DISTINCT_CLIENT_CAP + 1);
  });

  it('starts a new day with its own client set', () => {
    const store = createVisitorCounterStore(at('2026-08-11T00:00:00Z'));

    store.record('page', 'a', at('2026-08-11T10:00:00Z'));
    store.record('page', 'b', at('2026-08-11T11:00:00Z'));
    store.record('page', 'a', at('2026-08-12T10:00:00Z'));

    expect(store.snapshot(at('2026-08-12T12:00:00Z')).distinctClientsToday).toBe(1);
    expect(store.snapshot(at('2026-08-12T12:00:00Z')).window.page).toBe(3);
  });
});

describe('visitor counters — client keys', () => {
  it('gives the same key to the same ip+ua and a different one otherwise', () => {
    const store = createVisitorCounterStore(at('2026-08-12T09:00:00Z'));
    const ua = 'Mozilla/5.0 Chrome/131';

    expect(store.clientKeyFor('10.0.0.4', ua)).toBe(store.clientKeyFor('10.0.0.4', ua));
    expect(store.clientKeyFor('10.0.0.4', ua)).not.toBe(store.clientKeyFor('10.0.0.5', ua));
    expect(store.clientKeyFor('10.0.0.4', ua)).not.toBe(store.clientKeyFor('10.0.0.4', 'Firefox/130'));
  });

  it('never returns the address itself, and salts per process', () => {
    const a = createVisitorCounterStore(at('2026-08-12T09:00:00Z'));
    const b = createVisitorCounterStore(at('2026-08-12T09:00:00Z'));
    const key = a.clientKeyFor('192.168.1.77', 'Chrome');

    expect(key).not.toContain('192.168');
    // Two processes hash the same visitor to different keys — nothing here can
    // be correlated across a restart or read back into an address.
    expect(key).not.toBe(b.clientKeyFor('192.168.1.77', 'Chrome'));
  });

  it('returns null when there is no address to key on', () => {
    const store = createVisitorCounterStore(at('2026-08-12T09:00:00Z'));
    expect(store.clientKeyFor(undefined, 'Chrome')).toBeNull();
  });

  it('separates two clients that share an address but not a user agent', () => {
    // The NAT case, half-solved: two browsers behind one address do separate.
    // Two windows of the same browser do not — which is why the field is named
    // distinct *clients*, and rendered as an estimate.
    const store = createVisitorCounterStore(at('2026-08-12T09:00:00Z'));
    const now = at('2026-08-12T10:00:00Z');

    store.record('page', store.clientKeyFor('10.0.0.4', 'Chrome/131'), now);
    store.record('page', store.clientKeyFor('10.0.0.4', 'Firefox/130'), now);

    expect(store.snapshot(now).distinctClientsToday).toBe(2);
  });
});
