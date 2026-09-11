import { describe, expect, it } from 'vitest';
import { coreCaptureStalledNotice, endedSeriesNotice, formatEndedDate } from './endedSeriesNotice';

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

describe('coreCaptureStalledNotice', () => {
  it('dates what we hold without naming a cause', () => {
    const notice = coreCaptureStalledNotice('2026-09-07T21:45:00Z');
    expect(notice).toBe(
      `No Core net position captured since ${formatEndedDate(new Date('2026-09-07T21:45:00Z'))}.`
    );
    // The capture is ours (ABL-761): the upstream claim is the part that is false.
    expect(notice).not.toContain('upstream');
    expect(notice).not.toContain('not here');
  });

  it('prints the UTC day, not the viewer’s', () => {
    // JAO's day ends 21:45 UTC in summer — already tomorrow from UTC+3 east.
    expect(coreCaptureStalledNotice('2026-09-07T22:45:00Z')).toContain('7');
    expect(coreCaptureStalledNotice('2026-09-07T22:45:00Z')).not.toContain('8');
  });

  it('says nothing rather than claiming a stall it cannot date', () => {
    expect(coreCaptureStalledNotice(null)).toBeNull();
    expect(coreCaptureStalledNotice(undefined)).toBeNull();
    expect(coreCaptureStalledNotice('')).toBeNull();
    expect(coreCaptureStalledNotice('not-a-timestamp')).toBeNull();
  });
});
