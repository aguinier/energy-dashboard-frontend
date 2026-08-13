import { describe, it, expect } from 'vitest';
import { PublicApiError } from '../publicErrors.js';
import {
  MAX_ROW_LIMIT,
  MAX_WINDOW_DAYS,
  parseEnum,
  parseEnumList,
  parseInstant,
  parseLimit,
  parseWindow,
  parseZone,
  toIsoSecond,
} from './params.js';

/** The status/code/message of whatever a parser threw. */
function refusal(run: () => unknown): PublicApiError {
  try {
    run();
  } catch (error) {
    if (error instanceof PublicApiError) return error;
    throw error;
  }
  throw new Error('expected a PublicApiError');
}

describe('the timestamp contract', () => {
  it('accepts the canonical form and a bare date', () => {
    expect(parseInstant('2026-08-12T14:30:00Z', 'from').toISOString()).toBe(
      '2026-08-12T14:30:00.000Z'
    );
    expect(parseInstant('2026-08-12', 'from').toISOString()).toBe('2026-08-12T00:00:00.000Z');
  });

  it('truncates fractional seconds rather than refusing them', () => {
    // `new Date().toISOString()` is the most common way a client produces one of
    // these, and it emits milliseconds. Refusing would make the obvious idiom a
    // 400; truncating is safe because the stored resolution is 15 minutes at
    // its finest, so no sub-second component can select a different row.
    expect(toIsoSecond(parseInstant('2026-08-12T14:30:00.987Z', 'from'))).toBe(
      '2026-08-12T14:30:00Z'
    );
  });

  it.each([
    ['2026-08-12T14:30:00', 'no zone at all — parses as local time in a browser'],
    ['2026-08-12T14:30:00+02:00', 'an offset, which is not what this API speaks'],
    ['2026-08-12 14:30:00', 'a space separator, which is not RFC 3339'],
    ['12/08/2026', 'a local date format with no defined meaning'],
    ['2026-02-30', 'a date that does not exist'],
  ])('refuses %s (%s)', (value) => {
    const error = refusal(() => parseInstant(value, 'from'));
    expect(error.status).toBe(400);
    // Never echoes the input — a 400 body is the single most likely thing a
    // customer pastes into a public issue tracker.
    expect(error.message).not.toContain(value);
  });
});

describe('the window', () => {
  it('requires both ends, so there is no implicit clock in the contract', () => {
    // A default of "the last 24 hours" would silently truncate tomorrow's
    // day-ahead prices for every caller who did not think about it.
    expect(refusal(() => parseWindow({ from: '2026-08-01' })).code).toBe('window_required');
    expect(refusal(() => parseWindow({})).code).toBe('window_required');
  });

  it('is half-open, expressed as an inclusive SQL bound one second lower', () => {
    const window = parseWindow({ from: '2026-08-01', to: '2026-08-02' });
    expect(window.sqlStart).toBe('2026-08-01 00:00:00');
    expect(window.sqlEndInclusive).toBe('2026-08-01 23:59:59');
  });

  it('refuses an empty or inverted window', () => {
    expect(refusal(() => parseWindow({ from: '2026-08-02', to: '2026-08-01' })).code).toBe(
      'empty_window'
    );
    expect(refusal(() => parseWindow({ from: '2026-08-01', to: '2026-08-01' })).code).toBe(
      'empty_window'
    );
  });

  it(`caps the span at ${MAX_WINDOW_DAYS} days`, () => {
    expect(() => parseWindow({ from: '2025-08-13', to: '2026-08-13' })).not.toThrow();
    expect(refusal(() => parseWindow({ from: '2025-01-01', to: '2026-08-13' })).code).toBe(
      'window_too_large'
    );
  });
});

describe('the row cap', () => {
  it('defaults to the cap and can never exceed it', () => {
    expect(parseLimit(undefined)).toBe(MAX_ROW_LIMIT);
    expect(parseLimit('50')).toBe(50);
    // Asking for more than the cap gets the cap, not a 400: the caller asked
    // for as much as possible and that is what they get, with `meta.row_limit`
    // stating what was applied.
    expect(parseLimit('999999')).toBe(MAX_ROW_LIMIT);
  });

  it('refuses a limit that is not a whole positive number', () => {
    for (const bad of ['0', '-1', '1.5', 'ten', '']) {
      if (bad === '') {
        expect(parseLimit(bad)).toBe(MAX_ROW_LIMIT);
        continue;
      }
      expect(refusal(() => parseLimit(bad)).code).toBe('invalid_limit');
    }
  });
});

describe('zone', () => {
  it('upper-cases and requires exactly two letters', () => {
    expect(parseZone('de')).toBe('DE');
    expect(refusal(() => parseZone(undefined)).code).toBe('zone_required');
    for (const bad of ['D', 'DEU', 'D1', 'D-']) {
      expect(refusal(() => parseZone(bad)).code).toBe('invalid_zone');
    }
  });

  it('accepts a well-formed zone we do not hold, rather than 400ing on it', () => {
    // "We hold nothing for ZZ" and "ZZ is not a real zone" are answered by
    // /v1/catalog/zones. A 400 here would force every client to hardcode our
    // zone list to avoid one.
    expect(parseZone('ZZ')).toBe('ZZ');
  });
});

describe('every parameter is enumerable, so the request log stays non-personal', () => {
  // ABL-297 privacy notice §9 and ABL-301 item 4: request parameters are logged
  // per request by the usage meter, so no endpoint may accept free text or a
  // customer-supplied identifier. These are the four shapes `/v1` accepts, and
  // there is no fifth.

  it('rejects a repeated or structured parameter instead of picking one', () => {
    // Express turns `?zone=DE&zone=FR` into an array and `?zone[]=x` into an
    // object. Both reach a handler typed as `string`; an unguarded
    // `.toUpperCase()` is a 500 a caller can trigger from a URL bar.
    expect(refusal(() => parseZone(['DE', 'FR'])).status).toBe(400);
    expect(refusal(() => parseZone({ evil: 'x' })).status).toBe(400);
    expect(refusal(() => parseLimit(['1', '2'])).status).toBe(400);
  });

  it('refuses a value outside a fixed set, and lists the set without echoing input', () => {
    const error = refusal(() => parseEnum('sekrit-value', 'stream', ['load', 'price'], { required: true }));
    expect(error.code).toBe('invalid_stream');
    expect(error.message).toContain('load, price');
    expect(error.message).not.toContain('sekrit-value');
  });

  it('refuses an unknown member of a list rather than ignoring it', () => {
    // Silently dropping `production_type=nucular` returns all 21 types, which
    // reads as success and bills as success.
    expect(
      refusal(() => parseEnumList('solar,nucular', 'production_type', ['solar', 'nuclear'])).code
    ).toBe('invalid_production_type');
  });

  it('de-duplicates a list, so a caller mistake cannot double a column', () => {
    expect(parseEnumList('solar,solar,nuclear', 'production_type', ['solar', 'nuclear'])).toEqual([
      'solar',
      'nuclear',
    ]);
  });

  it('leaves an optional enum undefined when absent', () => {
    expect(parseEnum(undefined, 'model', ['catboost'], { required: false })).toBeUndefined();
    expect(refusal(() => parseEnum(undefined, 'type', ['load'], { required: true })).code).toBe(
      'type_required'
    );
  });
});
