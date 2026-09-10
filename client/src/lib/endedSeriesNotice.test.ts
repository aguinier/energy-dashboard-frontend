import { describe, expect, it } from 'vitest';
import { endedSeriesNotice, formatEndedDate } from './endedSeriesNotice';

describe('endedSeriesNotice', () => {
  it('names the last publication and says the stop is upstream', () => {
    const notice = endedSeriesNotice('2026-08-30T22:30:00Z');
    expect(notice).toBe(
      `No data published since ${formatEndedDate(new Date('2026-08-30T22:30:00Z'))}. ` +
        'The series has stopped upstream, not here.'
    );
    expect(notice).toContain('not here');
  });

  it('prints the UTC day, not the viewer’s', () => {
    // IE's last row. 22:30 UTC is already the next day east of Greenwich, so a
    // local-zone format would print 31 August to half of Europe.
    expect(endedSeriesNotice('2026-08-30T22:30:00Z')).toContain('30');
    expect(endedSeriesNotice('2026-08-30T22:30:00Z')).not.toContain('31');
  });

  it('accepts a Date as readily as a string', () => {
    expect(endedSeriesNotice(new Date('2026-09-04T21:00:00Z'))).toBe(
      endedSeriesNotice('2026-09-04T21:00:00Z')
    );
  });

  it('says nothing rather than claiming a stop it cannot date', () => {
    expect(endedSeriesNotice(null)).toBeNull();
    expect(endedSeriesNotice(undefined)).toBeNull();
    expect(endedSeriesNotice('')).toBeNull();
    expect(endedSeriesNotice('not-a-timestamp')).toBeNull();
  });
});
