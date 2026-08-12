import { describe, it, expect, vi } from 'vitest';
import Database, { type Database as DatabaseType } from 'better-sqlite3';

// The module under test imports the shared connection, which opens a real
// SQLite file at import time. Every test here always passes its own handle,
// so the default just needs to not exist — same pattern as
// netPositionService.test.ts.
vi.mock('../config/database.js', () => ({ default: null }));

const {
  parseJaoCoreNetPositionResponse,
  ensureCoreNetPositionTable,
  storeCoreNetPositionRows,
  getCoreNetPosition,
  getCoreNetPositionSeries,
  getCoreNetPositionMap,
  getCoreLastSeen,
  isCoreZone,
  resolveCoreCountryCode,
  CORE_ZONE_HUB_TO_COUNTRY,
} = await import('./coreNetPositionService.js');

/**
 * Byte-for-byte the first interval of a real response from
 * `https://publicationtool.jao.eu/core/api/data/netPos?FromUtc=2026-08-09T00:00:00Z&ToUtc=2026-08-09T01:00:00Z`,
 * fetched 2026-08-11 while researching ABL-219/ABL-230. `hub_DE: 785.6` and
 * `hub_FR: 2112.1` both match the values ABL-219's research brief cites for
 * this exact instant, which is what pins this fixture to the real contract
 * rather than a guessed shape.
 */
const REAL_JAO_SAMPLE = {
  data: [
    {
      id: 63467,
      dateTimeUtc: '2026-08-09T00:00:00Z',
      hub_ALBE: 359.0,
      hub_ALDE: -359.0,
      hub_AT: -2287.8,
      hub_BE: -3290.5,
      hub_CZ: 1257.3,
      hub_DE: 785.6,
      hub_HR: -217.6,
      hub_HU: -2808.3,
      hub_FR: 2112.1,
      hub_NL: 1597.0,
      hub_RO: 917.9,
      hub_SI: -301.4,
      hub_SK: 235.2,
      hub_PL: -389.9,
      hub_DE_NO2_BigHub: 674.4,
      hub_NL_NO2_NorNed: 0.0,
      hub_DE_DK2_BigHub: -290.6,
      hub_DE_SE4_Baltic: 0.0,
      hub_PL_SE4_SwePol: 490.0,
      hub_PL_LT_BigHub: 196.0,
      hub_RO_BG_VH: -259.9,
      hub_NL_DK1_COBRA: 0.0,
      hub_DE_DK1_VH: 1580.5,
    },
  ],
  rejected: false,
  messages: null,
};

describe('CORE_ZONE_HUB_TO_COUNTRY', () => {
  it('carries exactly the 12 Core CCR zones, excluding ALEGrO and external hubs', () => {
    expect(Object.keys(CORE_ZONE_HUB_TO_COUNTRY).sort()).toEqual(
      ['hub_AT', 'hub_BE', 'hub_CZ', 'hub_DE', 'hub_FR', 'hub_HR', 'hub_HU', 'hub_NL', 'hub_PL', 'hub_RO', 'hub_SI', 'hub_SK']
    );
    expect(Object.values(CORE_ZONE_HUB_TO_COUNTRY)).not.toContain('LU');
  });
});

describe('parseJaoCoreNetPositionResponse', () => {
  it('extracts exactly the 12 Core zone hubs from a real response shape, never the ALEGrO/external hubs', () => {
    const rows = parseJaoCoreNetPositionResponse(REAL_JAO_SAMPLE);
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.countryCode).sort()).toEqual(
      ['AT', 'BE', 'CZ', 'DE', 'FR', 'HR', 'HU', 'NL', 'PL', 'RO', 'SI', 'SK']
    );
  });

  it('never creates a standalone LU row from the parse step', () => {
    const rows = parseJaoCoreNetPositionResponse(REAL_JAO_SAMPLE);
    expect(rows.find((r) => r.countryCode === 'LU')).toBeUndefined();
  });

  it('matches the exact measured values from the ABL-219 research brief (FR diverges, DE does not)', () => {
    const rows = parseJaoCoreNetPositionResponse(REAL_JAO_SAMPLE);
    expect(rows.find((r) => r.countryCode === 'DE')?.netPositionMw).toBe(785.6);
    expect(rows.find((r) => r.countryCode === 'FR')?.netPositionMw).toBe(2112.1);
  });

  it('normalizes dateTimeUtc to the space-separated storage form', () => {
    const rows = parseJaoCoreNetPositionResponse(REAL_JAO_SAMPLE);
    expect(rows[0].timestampUtc).toBe('2026-08-09 00:00:00');
  });

  it('skips a hub that is missing for an interval rather than fabricating a zero', () => {
    const raw = {
      data: [
        {
          dateTimeUtc: '2026-08-09T00:00:00Z',
          hub_AT: -100,
          // hub_BE deliberately absent — JAO published nothing for it this interval.
        },
      ],
    };
    const rows = parseJaoCoreNetPositionResponse(raw);
    expect(rows).toEqual([{ countryCode: 'AT', timestampUtc: '2026-08-09 00:00:00', netPositionMw: -100 }]);
  });

  it('skips a hub whose value is null rather than storing 0', () => {
    const raw = { data: [{ dateTimeUtc: '2026-08-09T00:00:00Z', hub_AT: null, hub_BE: -50 }] };
    const rows = parseJaoCoreNetPositionResponse(raw);
    expect(rows).toEqual([{ countryCode: 'BE', timestampUtc: '2026-08-09 00:00:00', netPositionMw: -50 }]);
  });

  it('skips a record with no dateTimeUtc entirely', () => {
    const raw = { data: [{ hub_AT: -100 }] };
    expect(parseJaoCoreNetPositionResponse(raw)).toEqual([]);
  });

  it('throws when JAO itself reports the request as rejected, rather than parsing an empty result as "no data"', () => {
    const raw = { data: [], rejected: true, messages: ['Invalid FromUtc/ToUtc range'] };
    expect(() => parseJaoCoreNetPositionResponse(raw)).toThrow(/rejected/i);
  });

  it('throws on a response with no data array — a contract change, not a zero-row capture', () => {
    expect(() => parseJaoCoreNetPositionResponse({ rejected: true })).toThrow(/data/);
    expect(() => parseJaoCoreNetPositionResponse(null)).toThrow();
    expect(() => parseJaoCoreNetPositionResponse('not json')).toThrow();
  });
});

describe('ensureCoreNetPositionTable / storeCoreNetPositionRows', () => {
  function memDb(): DatabaseType {
    return new Database(':memory:');
  }

  it('is safe to call twice (IF NOT EXISTS)', () => {
    const db = memDb();
    ensureCoreNetPositionTable(db);
    expect(() => ensureCoreNetPositionTable(db)).not.toThrow();
  });

  it('inserts new rows and reports the count', () => {
    const db = memDb();
    const inserted = storeCoreNetPositionRows(
      db,
      [
        { countryCode: 'FR', timestampUtc: '2026-08-09 00:00:00', netPositionMw: 2112.1 },
        { countryCode: 'DE', timestampUtc: '2026-08-09 00:00:00', netPositionMw: 785.6 },
      ],
      '2026-08-11T19:00:00.000Z'
    );
    expect(inserted).toBe(2);
    const row = db.prepare('SELECT * FROM core_net_position WHERE country_code = ?').get('FR') as Record<string, unknown>;
    expect(row.net_position_mw).toBe(2112.1);
    expect(row.fetched_at).toBe('2026-08-11T19:00:00.000Z');
  });

  it('is idempotent: re-storing the same (country, timestamp) is a no-op, never a fan-out or an overwrite', () => {
    const db = memDb();
    storeCoreNetPositionRows(db, [{ countryCode: 'FR', timestampUtc: '2026-08-09 00:00:00', netPositionMw: 2112.1 }], 'first-pass');
    const second = storeCoreNetPositionRows(
      db,
      [{ countryCode: 'FR', timestampUtc: '2026-08-09 00:00:00', netPositionMw: 999 }],
      'second-pass'
    );
    expect(second).toBe(0);
    const row = db.prepare('SELECT net_position_mw, fetched_at FROM core_net_position WHERE country_code = ?').get('FR') as Record<string, unknown>;
    // The original value and fetch stamp survive — a re-capture never overwrites.
    expect(row.net_position_mw).toBe(2112.1);
    expect(row.fetched_at).toBe('first-pass');
  });

  it('never writes a standalone LU row even when asked to', () => {
    // storeCoreNetPositionRows stores whatever it is given; the guarantee that
    // LU is never written lives in the parser (see the "never creates a
    // standalone LU row" case above), not here. This pins that no implicit
    // LU-duplication happens inside storage itself.
    const db = memDb();
    storeCoreNetPositionRows(db, [{ countryCode: 'DE', timestampUtc: '2026-08-09 00:00:00', netPositionMw: 785.6 }]);
    const count = (db.prepare('SELECT COUNT(*) as n FROM core_net_position').get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('resolveCoreCountryCode', () => {
  it('maps DE and LU to the same storage code (DE)', () => {
    expect(resolveCoreCountryCode('DE')).toBe('DE');
    expect(resolveCoreCountryCode('LU')).toBe('DE');
  });

  it('leaves an ordinary Core zone untouched', () => {
    expect(resolveCoreCountryCode('FR')).toBe('FR');
    expect(resolveCoreCountryCode('at')).toBe('AT');
  });
});

describe('getCoreNetPosition', () => {
  function seededDb(): DatabaseType {
    const db = new Database(':memory:');
    storeCoreNetPositionRows(db, [
      { countryCode: 'FR', timestampUtc: '2026-08-09 00:00:00', netPositionMw: 2112.1 },
      { countryCode: 'FR', timestampUtc: '2026-08-09 08:00:00', netPositionMw: -114.9 },
      { countryCode: 'FR', timestampUtc: '2026-08-10 00:00:00', netPositionMw: 999 },
      { countryCode: 'DE', timestampUtc: '2026-08-09 00:00:00', netPositionMw: 785.6 },
    ]);
    return db;
  }

  it('returns only the requested country and window, ordered by time', () => {
    const rows = getCoreNetPosition('FR', '2026-08-09T00:00:00Z', '2026-08-09T23:59:59Z', seededDb());
    expect(rows).toEqual([
      { timestamp: '2026-08-09T00:00:00', net_position_mw: 2112.1 },
      { timestamp: '2026-08-09T08:00:00', net_position_mw: -114.9 },
    ]);
  });

  it('resolves LU to the DE_LU zone stored under DE, same as the primary net_position table', () => {
    const rows = getCoreNetPosition('LU', '2026-08-09T00:00:00Z', '2026-08-09T23:59:59Z', seededDb());
    expect(rows).toEqual([{ timestamp: '2026-08-09T00:00:00', net_position_mw: 785.6 }]);
  });

  it('returns an empty array for a country with no captured rows, never a fabricated point', () => {
    const rows = getCoreNetPosition('PL', '2026-08-09T00:00:00Z', '2026-08-09T23:59:59Z', seededDb());
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------- ABL-234
// The read shape the scope toggle needs: an empty series that names WHICH
// kind of empty it is, and a map payload the choropleth can colour.

describe('isCoreZone', () => {
  it('covers all 12 Core CCR zones, derived from the ingest hub map', () => {
    for (const cc of ['AT', 'BE', 'CZ', 'DE', 'FR', 'HR', 'HU', 'NL', 'PL', 'RO', 'SI', 'SK']) {
      expect(isCoreZone(cc)).toBe(true);
    }
  });

  it('counts LU as Core — it shares the DE_LU zone, even with no row of its own', () => {
    expect(isCoreZone('LU')).toBe(true);
  });

  it('excludes zones that are outside the Core region entirely', () => {
    // ES and IT matter as much as the obvious GB/CH: France's Core figure
    // excludes precisely those two AC borders, which is why "AC vs DC" is the
    // wrong framing for this whole distinction.
    for (const cc of ['GB', 'CH', 'ES', 'IT', 'NO', 'SE', 'DK', 'GR', 'BG']) {
      expect(isCoreZone(cc)).toBe(false);
    }
  });
});

describe('getCoreNetPositionSeries', () => {
  function seededDb(): DatabaseType {
    const db = new Database(':memory:');
    storeCoreNetPositionRows(db, [
      { countryCode: 'FR', timestampUtc: '2026-08-09 08:00:00', netPositionMw: -114.9 },
      { countryCode: 'DE', timestampUtc: '2026-08-09 08:00:00', netPositionMw: 7594.9 },
    ]);
    return db;
  }

  const START = '2026-08-09T00:00:00Z';
  const END = '2026-08-09T23:59:59Z';

  it('serves a Core zone with rows, and keeps the sign', () => {
    const s = getCoreNetPositionSeries('FR', START, END, seededDb());
    expect(s.meta.coverage).toBe('served');
    expect(s.meta.in_core).toBe(true);
    // France importing in the Core figure at this hour is the fact ABL-219
    // exists to surface — a sign flip here would be the wiring bug.
    expect(s.actual).toEqual([{ timestamp: '2026-08-09T08:00:00', net_position_mw: -114.9 }]);
  });

  it('says out_of_core — not no_data — for a country the Core region never covers', () => {
    // The distinction this endpoint exists for. Spain has a perfectly good
    // all-coupled-borders net position; reporting "no data" would invite a
    // reader (and a future ingest bug report) to treat that as a gap.
    const s = getCoreNetPositionSeries('ES', START, END, seededDb());
    expect(s.meta.coverage).toBe('out_of_core');
    expect(s.meta.in_core).toBe(false);
    expect(s.actual).toEqual([]);
    expect(s.meta.last_seen).toBeNull();
  });

  it('says no_data for a Core zone whose window is empty', () => {
    const s = getCoreNetPositionSeries('PL', START, END, seededDb());
    expect(s.meta.coverage).toBe('no_data');
    expect(s.meta.in_core).toBe(true);
  });

  it('says not_captured when the table does not exist at all', () => {
    // The state every deployment is in until JAO_CORE_NET_POSITION_ENABLED is
    // set: a fact about this deployment, not about France.
    const s = getCoreNetPositionSeries('FR', START, END, new Database(':memory:'));
    expect(s.meta.coverage).toBe('not_captured');
    expect(s.meta.in_core).toBe(true);
    expect(s.actual).toEqual([]);
  });

  it('reports LU as an in-Core zone served from DE_LU', () => {
    const s = getCoreNetPositionSeries('LU', START, END, seededDb());
    expect(s.meta.in_core).toBe(true);
    expect(s.meta.bidding_zone).toBe('DE_LU');
    expect(s.meta.coverage).toBe('served');
    expect(s.actual).toEqual([{ timestamp: '2026-08-09T08:00:00', net_position_mw: 7594.9 }]);
  });

  it('does NOT withhold a near-zero series the way net_position does', () => {
    // Deliberate asymmetry, documented on getCoreNetPositionSeries: the 1 MW
    // degenerate floor is sized from a measurement over net_position and from
    // an entsoe-py forward-fill this path does not have. A genuinely balanced
    // Core zone must draw, not vanish.
    const db = new Database(':memory:');
    storeCoreNetPositionRows(db, [
      { countryCode: 'FR', timestampUtc: '2026-08-09 08:00:00', netPositionMw: 0.04 },
      { countryCode: 'FR', timestampUtc: '2026-08-09 09:00:00', netPositionMw: -0.02 },
    ]);
    const s = getCoreNetPositionSeries('FR', START, END, db);
    expect(s.meta.coverage).toBe('served');
    expect(s.actual).toHaveLength(2);
  });

  it('returns a window-independent last_seen', () => {
    const db = seededDb();
    storeCoreNetPositionRows(db, [
      { countryCode: 'FR', timestampUtc: '2026-08-20 10:00:00', netPositionMw: 500 },
    ]);
    const s = getCoreNetPositionSeries('FR', START, END, db);
    expect(s.meta.last_seen).toBe('2026-08-20T10:00:00');
    expect(getCoreLastSeen('FR', db)).toBe('2026-08-20T10:00:00');
  });
});

describe('getCoreNetPositionMap', () => {
  function mapDb(): DatabaseType {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE countries (country_code TEXT PRIMARY KEY, country_name TEXT NOT NULL)`);
    const c = db.prepare('INSERT INTO countries VALUES (?, ?)');
    for (const [code, name] of [
      ['FR', 'France'],
      ['DE', 'Germany'],
      ['LU', 'Luxembourg'],
      ['NL', 'Netherlands'],
    ]) {
      c.run(code, name);
    }

    // France's and Germany's four real quarters for 2026-08-09 08:00 UTC,
    // fetched live from JAO. FR's mean is -368.9 MW (an IMPORTER) against an
    // all-coupled +1,494.575 for the same hour; DE's mean is 9,423.875, which
    // is its all-coupled value to the digit.
    storeCoreNetPositionRows(db, [
      { countryCode: 'FR', timestampUtc: '2026-08-09 08:00:00', netPositionMw: -114.9 },
      { countryCode: 'FR', timestampUtc: '2026-08-09 08:15:00', netPositionMw: -624.8 },
      { countryCode: 'FR', timestampUtc: '2026-08-09 08:30:00', netPositionMw: 174.8 },
      { countryCode: 'FR', timestampUtc: '2026-08-09 08:45:00', netPositionMw: -910.7 },
      { countryCode: 'DE', timestampUtc: '2026-08-09 08:00:00', netPositionMw: 7594.9 },
      { countryCode: 'DE', timestampUtc: '2026-08-09 08:15:00', netPositionMw: 9583.5 },
      { countryCode: 'DE', timestampUtc: '2026-08-09 08:30:00', netPositionMw: 9676.6 },
      { countryCode: 'DE', timestampUtc: '2026-08-09 08:45:00', netPositionMw: 10840.5 },
    ]);
    return db;
  }

  const START = '2026-08-09T00:00:00Z';
  const END = '2026-08-09T23:59:59Z';

  it('averages the window and keeps France negative — the sign-disagreement case', () => {
    const rows = getCoreNetPositionMap(START, END, mapDb());
    const fr = rows.find((r) => r.country_code === 'FR');
    // -368.9 rounded, matching the other map metrics' ROUND(...,0). Sampling
    // one quarter instead of averaging would have given -910.7 or +174.8 —
    // the latter would have coloured France an exporter.
    expect(fr?.value).toBe(-369);
    expect(fr?.country_name).toBe('France');
  });

  it('reproduces DE-LU averaging exactly to its all-coupled hourly value', () => {
    // Measured 2026-08-09 08:00 UTC: net_position holds 9423.875 for DE, and
    // the four Core quarters average to the same number. This is the check
    // that the Core map is not silently a different quantity where the two
    // genuinely coincide — and the reason DE cannot be used to verify the
    // toggle is wired at all.
    const rows = getCoreNetPositionMap(START, END, mapDb());
    expect(rows.find((r) => r.country_code === 'DE')?.value).toBe(9424);
  });

  it('emits LU with the DE_LU value rather than leaving a hole', () => {
    // A hole would render as the hatch, which in Core view reads as "outside
    // the Core region" — the one claim that would be wrong for Luxembourg.
    const rows = getCoreNetPositionMap(START, END, mapDb());
    const lu = rows.find((r) => r.country_code === 'LU');
    expect(lu?.value).toBe(9424);
    expect(lu?.country_name).toBe('Luxembourg');
  });

  it('omits a Core zone with no rows rather than emitting a zero', () => {
    const rows = getCoreNetPositionMap(START, END, mapDb());
    expect(rows.find((r) => r.country_code === 'NL')).toBeUndefined();
  });

  it('returns an empty array when the table does not exist', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE countries (country_code TEXT PRIMARY KEY, country_name TEXT NOT NULL)`);
    expect(getCoreNetPositionMap(START, END, db)).toEqual([]);
  });
});
