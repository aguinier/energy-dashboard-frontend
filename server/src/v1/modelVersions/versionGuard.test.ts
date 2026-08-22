import { describe, expect, it } from 'vitest';
import {
  ACKNOWLEDGED_VERSIONS,
  MATERIAL_NOTICE_DAYS,
  type AcknowledgementLedger,
  type VersionAcknowledgement,
} from './acknowledgements.js';
import {
  assertLedgerWellFormed,
  classifyVersion,
  createVersionGate,
  diffLedger,
  OPEN_VERSION_GATE,
  type ObservedVersion,
} from './versionGuard.js';

const DAY = 24 * 60 * 60 * 1000;

function record(over: Partial<VersionAcknowledgement> = {}): VersionAcknowledgement {
  return {
    id: 'r1',
    kind: 'baseline',
    acknowledged_at: '2026-08-01T00:00:00Z',
    acknowledged_by: 'API Platform Engineer',
    serve_from: '2026-08-01T00:00:00Z',
    note: 'seed',
    pairs: [{ zone: 'DE', forecast_type: 'load', model: 'catboost', model_version: 'v1' }],
    ...over,
  };
}

function observed(over: Partial<ObservedVersion> = {}): ObservedVersion {
  return {
    zone: 'DE',
    forecast_type: 'load',
    model: 'catboost',
    model_version: 'v1',
    newest_vintage_at: '2026-08-20T19:00:00',
    ...over,
  };
}

describe('the gate', () => {
  const now = new Date('2026-08-22T00:00:00Z');

  it('restricts nothing for a triple the ledger has never heard of', () => {
    // ToS §9.3.1: "beginning to serve a combination we did not serve before is
    // not" material. ABL-525's eight new pairs are exactly this, and a guard
    // that made them wait 30 days would block work §9.1 permits at any time.
    const gate = createVersionGate([record()], now);
    expect(gate.servableVersions('FR', 'solar', 'xgboost')).toBeNull();
  });

  it('restricts to the signed versions once the triple is in the ledger', () => {
    const gate = createVersionGate([record()], now);
    expect(gate.servableVersions('DE', 'load', 'catboost')).toEqual(['v1']);
  });

  it('does not leak an acknowledgement across models or forecast types', () => {
    // The ledger key is the whole triple. On the replica, AT/price/xgboost and
    // AT/renewable/xgboost genuinely share model_version '20260112_165237',
    // so keying on anything narrower would clear one pair by acknowledging
    // another.
    const gate = createVersionGate([record()], now);
    expect(gate.servableVersions('DE', 'load', 'xgboost')).toBeNull();
    expect(gate.servableVersions('DE', 'price', 'catboost')).toBeNull();
  });

  it('withholds a version whose notice period has not elapsed, and serves it afterwards', () => {
    // The whole §9.3 clock, in one assertion: the same ledger, read at two
    // instants, gives two answers. This is why the gate is built per request —
    // a gate resolved at startup would still be withholding v2 on day 31.
    const ledger: AcknowledgementLedger = [
      record(),
      record({
        id: 'r2',
        kind: 'material',
        acknowledged_at: '2026-08-22T00:00:00Z',
        serve_from: '2026-09-21T00:00:00Z',
        pairs: [{ zone: 'DE', forecast_type: 'load', model: 'catboost', model_version: 'v2' }],
      }),
    ];

    expect(createVersionGate(ledger, new Date('2026-09-01T00:00:00Z')).servableVersions('DE', 'load', 'catboost')).toEqual(['v1']);
    expect(createVersionGate(ledger, new Date('2026-09-21T00:00:01Z')).servableVersions('DE', 'load', 'catboost')).toEqual(['v1', 'v2']);
  });

  it('treats a triple named only by a future-dated record as known, not as new', () => {
    // The trap this closes: if an embargoed record did not mark the triple
    // "known", the A1 exemption would apply, `servableVersions` would return
    // null, and the gate would serve the very artifact the record exists to
    // hold back — the acknowledgement causing the breach it documents.
    const ledger = [
      record({ id: 'future', kind: 'material', serve_from: '2026-09-21T00:00:00Z', acknowledged_at: '2026-08-22T00:00:00Z' }),
    ];
    expect(createVersionGate(ledger, now).servableVersions('DE', 'load', 'catboost')).toEqual([]);
  });

  it('serves a correction immediately', () => {
    // ToS §9.3.2. Without this the guard would block the one change §9.3
    // explicitly permits us to ship at once — the live case being the NL
    // gross-basis load forecast (ABL-501 / ABL-505 / ABL-506).
    const ledger = [
      record(),
      record({
        id: 'fix',
        kind: 'correction',
        acknowledged_at: '2026-08-22T00:00:00Z',
        serve_from: '2026-08-22T00:00:00Z',
        pairs: [{ zone: 'DE', forecast_type: 'load', model: 'catboost', model_version: 'v2' }],
      }),
    ];
    expect(createVersionGate(ledger, now).servableVersions('DE', 'load', 'catboost')).toEqual(['v1', 'v2']);
  });

  it('OPEN_VERSION_GATE restricts nothing at all', () => {
    expect(OPEN_VERSION_GATE.servableVersions('DE', 'load', 'catboost')).toBeNull();
  });
});

describe('classifying one observed version', () => {
  const now = new Date('2026-08-22T00:00:00Z');

  it('names the four states apart', () => {
    const ledger = [
      record(),
      record({
        id: 'r2',
        kind: 'material',
        acknowledged_at: '2026-08-22T00:00:00Z',
        serve_from: '2026-09-21T00:00:00Z',
        pairs: [{ zone: 'DE', forecast_type: 'load', model: 'catboost', model_version: 'v2' }],
      }),
    ];

    expect(classifyVersion(ledger, observed({ model_version: 'v1' }), now)).toBe('servable');
    expect(classifyVersion(ledger, observed({ model_version: 'v2' }), now)).toBe('embargoed');
    expect(classifyVersion(ledger, observed({ model_version: 'v3' }), now)).toBe('unacknowledged');
    expect(classifyVersion(ledger, observed({ zone: 'FR' }), now)).toBe('additive');
  });

  it('treats a missing model_version as unacknowledged, never as a wildcard', () => {
    // 0 of 2,246,927 public rows carry a NULL model_version today, but "no
    // version" must fail closed if one ever appears: it would otherwise be an
    // artifact identity nobody could sign, passing every filter.
    expect(classifyVersion([record()], observed({ model_version: null }), now)).toBe('unacknowledged');
  });
});

describe('the ledger diff', () => {
  const now = new Date('2026-08-22T00:00:00Z');

  it('separates a superseded artifact from a triple that has gone', () => {
    // Two very different follow-ups. A superseded version is ordinary — the old
    // artifact stopped writing when the new one took over, and its entry is kept
    // on purpose because it is the fallback. A whole triple vanishing is ToS
    // §9.3.1 M4, material, and something this guard can report and cannot
    // prevent: there are no rows to withhold.
    const ledger = [
      record({
        pairs: [
          { zone: 'DE', forecast_type: 'load', model: 'catboost', model_version: 'v1' },
          { zone: 'ES', forecast_type: 'price', model: 'catboost', model_version: 'p1' },
        ],
      }),
    ];
    const diff = diffLedger([observed({ model_version: 'v2' })], ledger, now);

    expect(diff.unacknowledged.map((r) => r.model_version)).toEqual(['v2']);
    expect(diff.withdrawn).toEqual([
      { zone: 'DE', forecast_type: 'load', model: 'catboost', model_version: 'v1', triple_gone: false },
      { zone: 'ES', forecast_type: 'price', model: 'catboost', model_version: 'p1', triple_gone: true },
    ]);
  });

  it('reports a version once even when several records name it', () => {
    const ledger = [record({ id: 'a' }), record({ id: 'b' })];
    expect(diffLedger([], ledger, now).withdrawn).toHaveLength(1);
  });
});

describe('the checked-in ledger', () => {
  it('is well formed', () => {
    // Run against the real file, so a bad entry fails the suite instead of a
    // subscriber's request. The failure modes this catches are all silent at
    // runtime — see `assertLedgerWellFormed`.
    expect(() => assertLedgerWellFormed(ACKNOWLEDGED_VERSIONS)).not.toThrow();
  });

  it('refuses a material change that does not carry its 30 days', () => {
    // The §9.3 clock, enforced by the file rather than remembered by whoever
    // edits it. This is the mistake to expect: sign it and ship it the same
    // afternoon, with the ledger's blessing.
    expect(() =>
      assertLedgerWellFormed([
        record({
          kind: 'material',
          acknowledged_at: '2026-08-22T00:00:00Z',
          serve_from: '2026-08-23T00:00:00Z',
        }),
      ])
    ).toThrow(/must serve no earlier than 30 days/);
  });

  it('accepts a material change at exactly the notice period', () => {
    const signed = Date.parse('2026-08-22T00:00:00Z');
    expect(() =>
      assertLedgerWellFormed([
        record({
          kind: 'material',
          acknowledged_at: '2026-08-22T00:00:00Z',
          serve_from: new Date(signed + MATERIAL_NOTICE_DAYS * DAY).toISOString(),
        }),
      ])
    ).not.toThrow();
  });

  it('refuses an unparseable serve_from', () => {
    // `Date.parse` gives NaN, and `NaN <= now` is false, so the record would
    // never mature: the pair would blank on the day it was meant to cut over,
    // with nothing in the file looking wrong.
    expect(() => assertLedgerWellFormed([record({ serve_from: 'next tuesday' })])).toThrow(/never matures/);
  });

  it('refuses a duplicate id, an empty note and an empty version', () => {
    expect(() => assertLedgerWellFormed([record(), record()])).toThrow(/Duplicate acknowledgement id/);
    expect(() => assertLedgerWellFormed([record({ note: '  ' })])).toThrow(/empty note/);
    expect(() =>
      assertLedgerWellFormed([
        record({ pairs: [{ zone: 'DE', forecast_type: 'load', model: 'catboost', model_version: '' }] }),
      ])
    ).toThrow(/blank the pair/);
  });

  it('records exactly one servable version per triple', () => {
    // The property the baseline was measured to have and that a later edit
    // could quietly break: two live versions for one triple is not wrong in
    // itself (it is what a matured material change looks like), but two in the
    // *baseline* would mean the seed guessed rather than measured.
    const gate = createVersionGate(ACKNOWLEDGED_VERSIONS, new Date('2026-08-22T12:00:00Z'));
    const seen = new Map<string, number>();
    for (const entry of ACKNOWLEDGED_VERSIONS) {
      if (entry.kind !== 'baseline') continue;
      for (const pair of entry.pairs) {
        const key = `${pair.zone}|${pair.forecast_type}|${pair.model}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
        expect(gate.servableVersions(pair.zone, pair.forecast_type, pair.model)).toContain(
          pair.model_version
        );
      }
    }
    expect([...seen.values()].filter((n) => n > 1)).toEqual([]);
    expect(seen.size).toBe(74);
  });
});
