import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createV1Routes } from './index.js';
import { publicErrorHandler, publicNotFoundHandler } from '../publicErrors.js';
import {
  createMemoryDataContext,
  createMemoryEnergySource,
  type MemoryEnergySource,
} from '../data/memoryEnergySource.js';
import { MAX_ROW_LIMIT, MAX_WINDOW_DAYS } from '../data/params.js';

/**
 * The `/v1` contract, end to end, against a real database.
 *
 * This file exists because most of what ABL-303 promises is a promise about a
 * **response body**, and a promise about a response body is only kept if
 * something reads one. Six of the assertions below correspond to a sentence
 * somebody outside engineering has signed off on:
 *
 * | promise | where it comes from |
 * |---|---|
 * | every series names its source *and* its licence | ToS §7.3 — contractual, not a preference |
 * | ours is marked as ours | ABL-297 note on this issue |
 * | every response carries freshness | Board decision 2026-08-12 |
 * | pagination and the row cap are not skipped | ABL-291 brief §2, trap 2 |
 * | no link is built from the request host | ABL-291 brief §2, trap 1 |
 * | absent is never a silent zero | ABL-303 description; ABL-293 §2a |
 *
 * The routers are mounted on a bare app rather than through `createPublicApp`,
 * deliberately: the key gate and the meter are ABL-300's and ABL-301's, they
 * have their own suites, and threading a key through every request here would
 * mean a failure in the gate reads as a failure in the contract.
 * `publicApp.test.ts` covers the composed stack.
 */

let source: MemoryEnergySource;
let api: { origin: string; close: () => Promise<void> };

const NOW = new Date('2026-08-12T12:00:00Z');

/** `2026-08-12 11:00:00` — the space-separated form the ingest writes today. */
function stored(iso: string): string {
  return iso.replace('T', ' ').replace('Z', '');
}

beforeAll(async () => {
  source = createMemoryEnergySource();
  seed(source);

  const app = express();
  app.use(
    '/v1',
    createV1Routes(createMemoryDataContext(source, { now: () => NOW }))
  );
  app.use(publicNotFoundHandler);
  app.use(publicErrorHandler);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind');
  api = {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
});

afterAll(async () => {
  await api.close();
  source.close();
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${api.origin}${path}`);
  return { status: res.status, body: await res.json() };
}

/**
 * A fleet small enough to reason about and awkward enough to be worth testing.
 *
 * - **DE** — live, hourly load with a deliberate two-hour hole and one
 *   impossible `0.0`, day-ahead prices reaching into tomorrow, generation that
 *   reports solar and does not report nuclear, and two forecast vintages for the
 *   same target hour.
 * - **FR** — load only, and its forecasts are `xgboost` where DE's are
 *   `catboost`. That is the real fleet: the two models cover disjoint zone sets,
 *   so a hard-pinned model would blank one of them.
 * - **GB** — stopped publishing in 2021, which is true of the real GB. It is
 *   the zone that must read `ended` rather than `no_data`.
 * - **XX** — in `countries` and in nothing else. The zone that proves a
 *   catalogue reports what it does *not* hold.
 */
function seed(db: MemoryEnergySource): void {
  db.zones('DE', 'FR', 'GB', 'XX');

  // DE load: hourly 2026-08-10T00:00Z .. 2026-08-12T11:00Z.
  for (let hour = 0; hour < 60; hour += 1) {
    const at = new Date(Date.UTC(2026, 7, 10, hour));
    const iso = at.toISOString().slice(0, 19);
    // Two missing hours, so `resolution_uniform` has something to be false
    // about and `/v1/catalog/coverage` has a gap to enumerate.
    if (hour === 30 || hour === 31) continue;
    // One impossible zero. A national grid never draws 0 MW; this row is the
    // ingest writing a placeholder, and it must not reach a customer.
    db.load('DE', stored(`${iso}Z`), hour === 40 ? 0 : 40_000 + hour);
  }
  // A row stored with a trailing offset — two hours from where it belongs.
  db.load('DE', '2025-11-20 10:00:00+02:00', 41_000);

  // DE price: day-ahead, reaching into tomorrow, as a healthy price does.
  for (let hour = 0; hour < 48; hour += 1) {
    const iso = new Date(Date.UTC(2026, 7, 12, hour)).toISOString().slice(0, 19);
    // Negative prices are real. One is seeded so a client that treats them as
    // errors fails here rather than in production.
    db.price('DE', stored(`${iso}Z`), hour === 3 ? -12.5 : 90 + hour);
  }

  // DE generation: solar reported (including a measured overnight zero),
  // nuclear not reported at all.
  for (let hour = 0; hour < 24; hour += 1) {
    const iso = new Date(Date.UTC(2026, 7, 12, hour)).toISOString().slice(0, 19);
    db.generation('DE', stored(`${iso}Z`), {
      solar_mw: hour < 6 ? 0 : 5_000,
      wind_onshore_mw: 12_000,
      // `nuclear_mw` deliberately absent from the insert: SQL NULL, because DE
      // does not report it. It must arrive as JSON null, never as 0.
    });
  }

  // FR load, so the catalogue has a second zone with a different shape.
  for (let hour = 0; hour < 12; hour += 1) {
    const iso = new Date(Date.UTC(2026, 7, 12, hour)).toISOString().slice(0, 19);
    db.load('FR', stored(`${iso}Z`), 50_000 + hour);
  }

  // GB stopped in 2021 — and its rows are `T`-form, exactly as the real GB's
  // are, so the freshness map's separator handling is exercised.
  db.load('GB', '2021-06-14T09:00:00', 30_000);

  // DE load forecasts: two vintages covering the same target hours. The newer
  // one must win, and the older one must not appear.
  for (const [generatedAt, value] of [
    ['2026-08-12T07:00:00.100000', 100],
    ['2026-08-12T14:00:00.100000', 200],
  ] as const) {
    for (let hour = 12; hour < 20; hour += 1) {
      db.forecast({
        zone: 'DE',
        type: 'load',
        target: `2026-08-12T${String(hour).padStart(2, '0')}:00:00`,
        generatedAt,
        horizonHours: hour,
        value,
        model: 'catboost',
      });
    }
  }
  // FR is xgboost, not catboost — the disjoint-coverage case.
  for (let hour = 12; hour < 16; hour += 1) {
    db.forecast({
      zone: 'FR',
      type: 'load',
      target: `2026-08-12T${String(hour).padStart(2, '0')}:00:00`,
      generatedAt: '2026-08-12T14:00:00.100000',
      horizonHours: hour,
      value: 300,
      model: 'xgboost',
    });
  }
  // Net position rows in the same table, so "excluded" is exercised against
  // data that is actually present rather than against an empty case.
  db.forecast({
    zone: 'DE',
    type: 'net_position',
    target: '2026-08-12T12:00:00',
    generatedAt: '2026-08-12T14:00:00.100000',
    horizonHours: 12,
    value: 900,
    model: 'catboost',
  });

  // Ingest passes. The third one is the shape of the 2026-08-06 ENTSO-E outage:
  // `status = 'completed'` with everything failed and nothing stored.
  db.ingestPass({
    pipelineType: 'load',
    zone: 'DE',
    startTime: '2026-08-12T06:30:00+00:00',
    endTime: '2026-08-12T06:41:00+00:00',
  });
  db.ingestPass({
    pipelineType: 'load',
    zone: 'DE',
    startTime: '2026-08-12T11:30:00+00:00',
    endTime: '2026-08-12T11:41:00+00:00',
    recordsFailed: 3,
  });
  db.ingestPass({
    pipelineType: 'price',
    zone: 'DE',
    startTime: '2026-08-12T06:30:00+00:00',
    endTime: '2026-08-12T06:42:00+00:00',
  });
  db.ingestPass({
    pipelineType: 'renewable',
    zone: 'DE',
    startTime: '2026-08-12T06:30:00+00:00',
    endTime: '2026-08-12T06:43:00+00:00',
  });
}

const DE_DAY = 'zone=DE&from=2026-08-12&to=2026-08-13';

describe('ToS §7.3 — every series names its source and its licence', () => {
  // The one promise on this list that fails on **day one** rather than
  // eventually: a subscriber can read it straight off the first response body.
  // §7.2 is why it cannot be softened — the attribution duty flows from CC-BY
  // 4.0 upstream and we are not able to waive it.

  it.each(['load', 'price', 'generation'])(
    'observations/%s carries ENTSO-E and CC-BY 4.0 on every series',
    async (stream) => {
      const { body } = await get(`/v1/observations/${stream}?${DE_DAY}`);

      expect(body.meta.series.length).toBeGreaterThan(0);
      for (const series of body.meta.series) {
        expect(series.source.name).toBe('ENTSO-E Transparency Platform');
        expect(series.source.licence).toBe('CC-BY-4.0');
        expect(series.source.attribution_required).toBe(true);
        expect(series.source.attribution).toContain('CC-BY 4.0');
        // A unit on every numeric field, which the internal API strips.
        expect(series.unit).toMatch(/^(MW|EUR\/MWh)$/);
      }
    }
  );

  it('generation names all 21 production types as separately licensed series', async () => {
    // §8.1: "Different parts of a single response may be subject to different
    // terms. The per-series source field tells you which is which." Twenty-one
    // series in one response is the case that makes a response-level licence
    // field wrong.
    const { body } = await get(`/v1/observations/generation?${DE_DAY}`);
    expect(body.meta.series).toHaveLength(21);
  });

  it.each(['/v1/forecasts?zone=DE&type=load&from=2026-08-12&to=2026-08-13', '/v1/forecasts/latest?zone=DE&type=load'])(
    'our own output at %s is marked as ours, and needs no attribution',
    async (path) => {
      const { body } = await get(path);

      expect(body.meta.series).toHaveLength(1);
      const { source } = body.meta.series[0];
      // Present on our series too — that is the point. A subscriber branches on
      // `attribution_required` instead of maintaining a list of which of our
      // fields came from where.
      expect(source.id).toBe('able');
      expect(source.name).toBe('Able Energy');
      expect(source.licence).toBe('proprietary');
      expect(source.attribution_required).toBe(false);
      expect(source.attribution).toBeNull();
    }
  );

  it('the catalogue says whose data it is describing, too', async () => {
    const zones = await get('/v1/catalog/zones');
    expect(zones.body.data[0].streams[0].source.licence).toBe('CC-BY-4.0');

    const models = await get('/v1/catalog/models');
    expect(models.body.data[0].source.id).toBe('able');
  });
});

describe('freshness on every response (Board, 2026-08-12)', () => {
  it.each([
    ['/v1/observations/load?' + DE_DAY],
    ['/v1/observations/price?' + DE_DAY],
    ['/v1/observations/generation?' + DE_DAY],
    ['/v1/forecasts?zone=DE&type=load&from=2026-08-12&to=2026-08-13'],
    ['/v1/forecasts/latest?zone=DE&type=load'],
  ])('%s carries all four freshness fields', async (path) => {
    const { body } = await get(path);
    expect(Object.keys(body.meta.freshness).sort()).toEqual([
      'data_through',
      'generated_at',
      'source_checked_at',
      'status',
    ]);
    expect(body.meta.freshness.generated_at).toBe('2026-08-12T12:00:00Z');
  });

  it('judges a day-ahead price on coverage, not on age — it is dated in the future', async () => {
    // The reason a single scalar `as_of` was refused (ABL-293 §2g). DE's newest
    // price is dated 2026-08-13T23:00Z, ~35 hours *ahead* of the clock. Judged
    // by age it would read as impossibly fresh forever, and a missing tomorrow
    // would never surface — which is ABL-51 rebuilt as a public contract.
    const { body } = await get(`/v1/observations/price?${DE_DAY}`);

    expect(body.meta.freshness.data_through > '2026-08-12T12:00:00Z').toBe(true);
    expect(body.meta.freshness.status).toBe('live');
  });

  it('reports source_checked_at from a pass that failed nothing, not from status', async () => {
    // `data_ingestion_log.status` was `'completed'` on 114,982 of 114,983 rows;
    // ABL-633 has since made it derive from the counts, but every row written
    // before that deploy keeps its old label. DE's 11:30 load pass is seeded as
    // `completed` with `records_failed = 3` — the shape of the 2026-08-06
    // outage, and of every pre-ABL-633 row. The honest answer is the 06:30 pass.
    const { body } = await get(`/v1/observations/load?${DE_DAY}`);
    expect(body.meta.freshness.source_checked_at).toBe('2026-08-12T06:41:00Z');
  });

  it('says nothing about an upstream pass for our own forecasts', async () => {
    // `null` rather than the ENTSO-E ingest that fed the model's features:
    // that would answer a question about a different thing.
    const { body } = await get('/v1/forecasts?zone=DE&type=load&from=2026-08-12&to=2026-08-13');
    expect(body.meta.freshness.source_checked_at).toBeNull();
  });

  it('marks a zone that stopped publishing as ended, not as empty', async () => {
    const { body } = await get('/v1/observations/load?zone=GB&from=2026-08-12&to=2026-08-13');

    expect(body.data).toEqual([]);
    expect(body.meta.freshness.status).toBe('ended');
    // And the empty page says *why* it is empty. `no_data` here rather than
    // `upstream_gap`: the window is entirely outside what we hold, so this is
    // "we have nothing for that period", not "upstream dropped it".
    expect(body.meta.coverage).toBe('no_data');
  });
});

describe('absent is absent — never a silent zero', () => {
  it('returns null for a production type the zone does not report', async () => {
    const { body } = await get(`/v1/observations/generation?${DE_DAY}`);
    const row = body.data[0];

    // Present as a key, null as a value. Omitting it would make "does not
    // report" indistinguishable from "we dropped it"; zeroing it would invent a
    // measurement.
    expect(Object.prototype.hasOwnProperty.call(row, 'nuclear')).toBe(true);
    expect(row.nuclear).toBeNull();
  });

  it('keeps a measured overnight zero, because that one is a measurement', async () => {
    const { body } = await get(`/v1/observations/generation?${DE_DAY}`);
    // Solar at 03:00 is 0.0 and that is real. The NULL rule and the zero rule
    // point in opposite directions and both have to hold in one response.
    expect(body.data[3].solar).toBe(0);
    expect(body.data[12].solar).toBe(5_000);
  });

  it('drops an impossible zero load rather than serving a confident 0 MW', async () => {
    const { body } = await get('/v1/observations/load?zone=DE&from=2026-08-11&to=2026-08-12');
    expect(body.data.every((row: { load: number }) => row.load > 0)).toBe(true);
  });

  it('keeps a negative price, because negative prices are real', async () => {
    const { body } = await get(`/v1/observations/price?${DE_DAY}`);
    expect(body.data.find((row: { price: number }) => row.price === -12.5)).toBeDefined();
    expect(body.meta.series[0].signed).toBe(true);
  });

  it('does not interpolate across a hole, and says the spacing is not uniform', async () => {
    const { body } = await get('/v1/observations/load?zone=DE&from=2026-08-11&to=2026-08-12');

    expect(body.meta.resolution).toBe('PT1H');
    expect(body.meta.resolution_uniform).toBe(false);
    // The two missing hours are missing. No forward-fill, no carry-forward —
    // that habit is how 216 fabricated net_position rows reached this database.
    const stamps = body.data.map((row: { timestamp: string }) => row.timestamp);
    expect(stamps).not.toContain('2026-08-11T06:00:00Z');
    expect(stamps).not.toContain('2026-08-11T07:00:00Z');
  });

  it('excludes the rows stored with a UTC offset, and says so on the response', async () => {
    const { body } = await get('/v1/observations/load?zone=DE&from=2025-11-20&to=2025-11-21');

    expect(body.data).toEqual([]);
    expect(body.meta.excluded[0].reason).toBe('non_utc_stored_timestamp');
    expect(body.meta.excluded[0].detail).toContain('2025-11-13');
  });
});

describe('the timestamp and timezone contract', () => {
  it('emits RFC 3339 UTC with an explicit Z, at second precision', async () => {
    const { body } = await get(`/v1/observations/load?${DE_DAY}`);
    for (const row of body.data) {
      expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
    expect(body.meta.from).toBe('2026-08-12T00:00:00Z');
    expect(body.meta.to).toBe('2026-08-13T00:00:00Z');
  });

  it('is half-open: from is included, to is not', async () => {
    const { body } = await get(
      '/v1/observations/load?zone=DE&from=2026-08-12T00:00:00Z&to=2026-08-12T03:00:00Z'
    );
    const stamps = body.data.map((row: { timestamp: string }) => row.timestamp);

    expect(stamps).toContain('2026-08-12T00:00:00Z');
    expect(stamps).not.toContain('2026-08-12T03:00:00Z');
    // Three intervals, not four. A caller summing inclusive-bounds pages
    // double-counts one interval per page, and the error is small enough to
    // read as rounding.
    expect(stamps).toHaveLength(3);
  });

  it('refuses a timestamp that does not say what zone it is in', async () => {
    for (const bad of ['2026-08-12T00:00:00', '2026-08-12T00:00:00+02:00', '2026-08-12 00:00:00']) {
      const { status, body } = await get(
        `/v1/observations/load?zone=DE&from=${encodeURIComponent(bad)}&to=2026-08-13`
      );
      expect(status).toBe(400);
      expect(body.error.code).toBe('invalid_from');
      // The message describes the expected form and never echoes what was sent.
      expect(body.error.message).not.toContain(bad);
    }
  });

  it('accepts the millisecond form every client library emits', async () => {
    const { status } = await get(
      '/v1/observations/load?zone=DE&from=2026-08-12T00:00:00.000Z&to=2026-08-13T00:00:00.000Z'
    );
    expect(status).toBe(200);
  });
});

describe('the row cap and pagination are not skipped because the dataset is small', () => {
  // ABL-291 brief §2, trap 2. The row cap is a *term of the contract* and the
  // single most expensive item on ABL-293's list to retrofit: a customer who
  // built against an uncapped response experiences its introduction as one
  // billed request becoming twenty-one.

  it('states the cap on every response, even when it did not bite', async () => {
    const { body } = await get(`/v1/observations/load?${DE_DAY}`);
    expect(body.meta.row_limit).toBe(MAX_ROW_LIMIT);
    expect(body.meta.truncated).toBe(false);
    expect(body.links.next).toBeNull();
  });

  it('truncates, says so, and hands back a cursor that continues exactly', async () => {
    const first = await get('/v1/observations/load?zone=DE&from=2026-08-10&to=2026-08-13&limit=5');

    expect(first.body.data).toHaveLength(5);
    expect(first.body.meta.truncated).toBe(true);
    expect(first.body.links.next).toContain('cursor=');

    const second = await get(first.body.links.next);
    expect(second.body.data[0].timestamp > first.body.data[4].timestamp).toBe(true);

    // Walk the whole series through the cursor and compare against one
    // unpaginated read. Pagination that loses or repeats an interval is the
    // defect offset pagination has against a table a cron upserts four times a
    // day, and it is invisible in a single page.
    const whole = await get('/v1/observations/load?zone=DE&from=2026-08-10&to=2026-08-13');
    const walked: string[] = [];
    let next: string | null = '/v1/observations/load?zone=DE&from=2026-08-10&to=2026-08-13&limit=5';
    while (next) {
      const page: { body: any } = await get(next);
      walked.push(...page.body.data.map((row: { timestamp: string }) => row.timestamp));
      next = page.body.links.next;
    }
    expect(walked).toEqual(whole.body.data.map((row: { timestamp: string }) => row.timestamp));
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('truncated is a fact, not row_count === row_limit', async () => {
    // DE holds exactly 12 rows on 2026-08-12 for generation. A limit of 12 must
    // report `truncated: false` and no `next` — otherwise this caller follows a
    // link to an empty page forever, one billed request at a time.
    const { body } = await get(
      '/v1/observations/generation?zone=DE&from=2026-08-12T00:00:00Z&to=2026-08-12T12:00:00Z&limit=12'
    );
    expect(body.data).toHaveLength(12);
    expect(body.meta.truncated).toBe(false);
    expect(body.links.next).toBeNull();
  });

  it('refuses a window wider than the cap rather than scanning it', async () => {
    const { status, body } = await get(
      '/v1/observations/load?zone=DE&from=2019-01-01&to=2026-08-13'
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe('window_too_large');
    expect(body.error.message).toContain(String(MAX_WINDOW_DAYS));
  });

  it('refuses a cursor minted for a different query', async () => {
    const de = await get('/v1/observations/load?zone=DE&from=2026-08-10&to=2026-08-13&limit=5');
    const cursor = new URL(`http://x${de.body.links.next}`).searchParams.get('cursor');

    // The same cursor, pointed at FR. Without the query fingerprint this would
    // answer with FR rows starting at a timestamp DE happened to end on,
    // presented as page two of a DE series.
    const { status, body } = await get(
      `/v1/observations/load?zone=FR&from=2026-08-10&to=2026-08-13&limit=5&cursor=${encodeURIComponent(cursor ?? '')}`
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe('invalid_cursor');
  });
});

describe('links are configuration, never the request host', () => {
  // ABL-291 brief §2, trap 1. On the LAN `PUBLIC_BASE_URL` is unset, so links
  // come back relative — correct against whatever origin the client used, and
  // incapable of baking `192.168.86.36` into a subscriber's stored URL.

  it('emits relative links when no public base URL is configured', async () => {
    const { body } = await get('/v1/observations/load?zone=DE&from=2026-08-10&to=2026-08-13&limit=5');

    expect(body.links.self.startsWith('/v1/')).toBe(true);
    expect(body.links.next.startsWith('/v1/')).toBe(true);
    expect(body.links.next).not.toContain('127.0.0.1');
    expect(body.links.next).not.toContain(api.origin);
  });

  it('uses the configured base URL when there is one, and still not the host', async () => {
    const configured = express();
    configured.use(
      '/v1',
      createV1Routes(
        createMemoryDataContext(source, { now: () => NOW, publicBaseUrl: 'https://api.example.com' })
      )
    );
    const server: Server = await new Promise((resolve) => {
      const s = configured.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address() as { port: number };
    try {
      const res = await fetch(
        `http://127.0.0.1:${addr.port}/v1/observations/load?zone=DE&from=2026-08-10&to=2026-08-13&limit=5`
      );
      const body = await res.json();
      expect(body.links.next.startsWith('https://api.example.com/v1/')).toBe(true);
      expect(body.links.next).not.toContain('127.0.0.1');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('forecasts', () => {
  it('returns the newest vintage per target hour, and says which run produced it', async () => {
    const { body } = await get('/v1/forecasts?zone=DE&type=load&from=2026-08-12&to=2026-08-13');

    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) {
      // The 07:00 vintage is superseded by the 14:00 one for these hours.
      expect(row.value).toBe(200);
      // Mandatory on every row, never an `include=`. At 03:00 UTC the newest
      // vintage is eight hours old because our runs stop at 19:00 and resume at
      // 07:00; this field is what says so.
      expect(row.generated_at).toBe('2026-08-12T14:00:00Z');
      expect(typeof row.horizon_hours).toBe('number');
      expect(row.model).toBe('catboost');
    }
    expect(body.meta.model).toBe('catboost');
    expect(body.meta.latest_vintage_at).toBe('2026-08-12T14:00:00Z');
  });

  it('falls back to the model that actually covers a zone, and names it', async () => {
    // FR is xgboost where DE is catboost. Pinning one would blank the other.
    const { body } = await get('/v1/forecasts?zone=FR&type=load&from=2026-08-12&to=2026-08-13');
    expect(body.meta.model).toBe('xgboost');
    expect(body.data.every((row: { model: string }) => row.model === 'xgboost')).toBe(true);
  });

  it('honours an explicit model strictly, rather than substituting one that has rows', async () => {
    // Asking how xgboost forecasts and receiving catboost is the
    // plausible-wrong-number-under-the-wrong-label failure this codebase exists
    // to avoid.
    const { body } = await get(
      '/v1/forecasts?zone=DE&type=load&model=xgboost&from=2026-08-12&to=2026-08-13'
    );
    expect(body.data).toEqual([]);
    expect(body.meta.model).toBe('xgboost');
    expect(body.meta.coverage).toBe('out_of_scope');
  });

  it('serves one whole run at /latest, not a stitch of several', async () => {
    const { body } = await get('/v1/forecasts/latest?zone=DE&type=load');

    expect(body.data).toHaveLength(8);
    expect(new Set(body.data.map((row: { generated_at: string }) => row.generated_at)).size).toBe(1);
    expect(body.links.next).toBeNull();
  });

  it('refuses a horizon beyond what the data reaches, rather than returning nothing', async () => {
    const { status, body } = await get(
      '/v1/forecasts?zone=DE&type=load&horizon=168&from=2026-08-12&to=2026-08-13'
    );
    expect(status).toBe(400);
    expect(body.error.message).toContain('no D+3');
  });
});

describe('net position is absent by construction (Board decision 2)', () => {
  it('is not an accepted forecast type, even though the rows are in the table', async () => {
    const { status, body } = await get(
      '/v1/forecasts?zone=DE&type=net_position&from=2026-08-12&to=2026-08-13'
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe('invalid_type');
  });

  it('is not an observation stream', async () => {
    expect((await get(`/v1/observations/net-position?${DE_DAY}`)).status).toBe(404);
    expect((await get('/v1/catalog/coverage?zone=DE&stream=net_position')).status).toBe(400);
  });

  it('is not in the model catalogue', async () => {
    const { body } = await get('/v1/catalog/models');
    expect(
      body.data.some((entry: { forecast_type: string }) => entry.forecast_type === 'net_position')
    ).toBe(false);
  });
});

describe('the catalogue narrates absence', () => {
  it('lists a zone we hold nothing for, rather than omitting it', async () => {
    const { body } = await get('/v1/catalog/zones');
    const xx = body.data.find((entry: { zone: string }) => entry.zone === 'XX');

    expect(xx).toBeDefined();
    for (const stream of xx.streams) {
      expect(stream.status).toBe('none');
      expect(stream.data_from).toBeNull();
    }
  });

  it('enumerates the exact holes in a window, and counts what was excluded', async () => {
    const { body } = await get(
      '/v1/catalog/coverage?zone=DE&stream=load&from=2026-08-11T00:00:00Z&to=2026-08-12T00:00:00Z'
    );
    const coverage = body.data[0];

    expect(coverage.status).toBe('live');
    expect(coverage.window.resolution).toBe('PT1H');
    // Two holes, and they have different causes — which is the point of
    // enumerating them rather than reporting a count of present rows.
    expect(coverage.window.gaps).toEqual([
      // Upstream never published these two hours.
      { from: '2026-08-11T06:00:00Z', to: '2026-08-11T08:00:00Z', missing_intervals: 2 },
      // And this one is *ours*: the seeded 16:00 row holds an impossible
      // `0.0 MW`, which `measuredLoadClause()` removes. A row we decline to
      // serve has to appear here as a hole, or the data endpoint and the
      // coverage endpoint would disagree about the same hour — the coverage
      // endpoint claiming a row exists that no query can return.
      { from: '2026-08-11T16:00:00Z', to: '2026-08-11T17:00:00Z', missing_intervals: 1 },
    ]);
  });

  it('reports the excluded offset rows as a count rather than silently', async () => {
    const { body } = await get(
      '/v1/catalog/coverage?zone=DE&stream=load&from=2025-11-20T00:00:00Z&to=2025-11-21T00:00:00Z'
    );
    expect(body.data[0].window.excluded_row_count).toBe(1);
    expect(body.data[0].window.row_count).toBe(0);
  });

  it('answers the cheap question without a window', async () => {
    const { body } = await get('/v1/catalog/coverage?zone=DE&stream=load');
    expect(body.data[0].window).toBeUndefined();
    expect(body.data[0].data_from).toBe('2026-08-10T00:00:00Z');
    expect(body.data[0].data_through).toBe('2026-08-12T11:00:00Z');
  });

  it('advertises only models that actually have rows', async () => {
    const { body } = await get('/v1/catalog/models');
    const loadEntries = body.data.filter(
      (entry: { forecast_type: string }) => entry.forecast_type === 'load'
    );

    expect(loadEntries.map((e: { model: string }) => e.model).sort()).toEqual([
      'catboost',
      'xgboost',
    ]);
    expect(loadEntries.find((e: { model: string }) => e.model === 'catboost').zones).toEqual(['DE']);
    expect(loadEntries.find((e: { model: string }) => e.model === 'xgboost').zones).toEqual(['FR']);
    // Stability is published, so a subscriber can see that six of the eight
    // offered types are thin before they buy a plan for their market.
    expect(loadEntries[0].stability).toBe('stable');
  });
});

describe('an empty page always says why', () => {
  it('distinguishes an upstream hole from a period we do not hold', async () => {
    // Inside the span we hold, and empty: upstream did not publish it. This is
    // the one that must not read as our failure — MK has rows on 30 of 46 dates.
    const gap = await get(
      '/v1/observations/load?zone=DE&from=2026-08-11T06:00:00Z&to=2026-08-11T08:00:00Z'
    );
    expect(gap.body.data).toEqual([]);
    expect(gap.body.meta.coverage).toBe('upstream_gap');

    // Outside it: we simply hold nothing for that period.
    const before = await get('/v1/observations/load?zone=DE&from=2020-01-01&to=2020-01-02');
    expect(before.body.meta.coverage).toBe('no_data');

    // Nothing for this zone and stream at any time.
    const never = await get(`/v1/observations/price?zone=XX&from=2026-08-12&to=2026-08-13`);
    expect(never.body.meta.coverage).toBe('out_of_scope');
  });
});
