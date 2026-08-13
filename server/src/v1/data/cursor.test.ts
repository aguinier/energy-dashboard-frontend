import { describe, it, expect } from 'vitest';
import { PublicApiError } from '../publicErrors.js';
import { decodeCursor, encodeCursor, queryFingerprint } from './cursor.js';

const FP = queryFingerprint('/v1/observations/load', {
  zone: 'DE',
  from: '2026-08-01T00:00:00Z',
  to: '2026-08-02T00:00:00Z',
  limit: 100,
});

describe('queryFingerprint', () => {
  it('is order-independent, because parameter order is not part of a query', () => {
    // Built from parsed values rather than the raw query string. Fingerprinting
    // the string instead would break `links.next` whenever a client's HTTP
    // library reordered parameters, and that failure arrives as "your
    // pagination is flaky".
    expect(queryFingerprint('/p', { a: '1', b: '2' })).toBe(
      queryFingerprint('/p', { b: '2', a: '1' })
    );
  });

  it('changes when anything that changes the page changes', () => {
    expect(queryFingerprint('/p', { zone: 'DE' })).not.toBe(queryFingerprint('/p', { zone: 'FR' }));
    expect(queryFingerprint('/p', { zone: 'DE' })).not.toBe(queryFingerprint('/q', { zone: 'DE' }));
  });
});

describe('decodeCursor', () => {
  it('round-trips a timestamp', () => {
    expect(decodeCursor(encodeCursor(FP, '2026-08-01 12:00:00'), FP)).toBe('2026-08-01 12:00:00');
  });

  it('is undefined when no cursor was sent', () => {
    expect(decodeCursor(undefined, FP)).toBeUndefined();
  });

  it('refuses a cursor minted for a different query', () => {
    // The failure this prevents: `…?zone=DE&…&cursor=X` re-sent as
    // `…?zone=FR&…&cursor=X` would otherwise be answered with FR rows starting
    // at a timestamp DE happened to end on, presented as page two of a DE
    // series. A plausible answer to a question nobody asked.
    const other = queryFingerprint('/v1/observations/load', { zone: 'FR' });
    expect(() => decodeCursor(encodeCursor(FP, '2026-08-01 12:00:00'), other)).toThrow(
      PublicApiError
    );
  });

  it.each([
    ['not-base64-at-all!!', 'garbage'],
    [Buffer.from('{"v":1}', 'utf8').toString('base64url'), 'missing fields'],
    [Buffer.from('not json', 'utf8').toString('base64url'), 'not JSON'],
    [Buffer.from(JSON.stringify({ v: 2, q: FP, t: '2026-08-01 12:00:00' })).toString('base64url'), 'a future version'],
    [Buffer.from(JSON.stringify({ v: 1, q: FP, t: "2026-08-01' OR 1=1--" })).toString('base64url'), 'a timestamp that is not one'],
  ])('refuses %s (%s)', (cursor) => {
    const error = (() => {
      try {
        decodeCursor(cursor, FP);
      } catch (e) {
        return e as PublicApiError;
      }
      throw new Error('expected a refusal');
    })();

    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_cursor');
    // One message for every failure path. Distinguishing them would describe
    // our encoding to somebody who is, by definition, not following links.next.
    expect(error.message).toContain('opaque');
    expect(error.message).not.toContain(cursor);
  });

  it('refuses an empty or non-string cursor', () => {
    expect(() => decodeCursor('', FP)).toThrow(PublicApiError);
    expect(() => decodeCursor(['a', 'b'], FP)).toThrow(PublicApiError);
  });
});
