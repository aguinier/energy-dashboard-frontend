import { describe, it, expect } from 'vitest';
import {
  REFRESH_STREAM_ORDER,
  describeAllRefreshes,
  describeRefresh,
} from './lastRefreshed';
import type { IngestFreshness, StreamRefresh } from '@/types';

/**
 * ABL-295. The property under test is a negative one: the panel must never
 * print a "refreshed" time it did not measure. Every fallback from
 * `lastStoredRows` to `lastChecked` would be a plausible, recent, wrong timestamp
 * — the exact defect the endpoint exists to prevent.
 */

const NOW = new Date('2026-08-12T06:00:00Z');
/** Two hours before NOW — the 00:30-00:48 UTC pass, roughly. */
const RECENT = '2026-08-12T04:00:00.123456+00:00';
/** Six weeks before NOW. */
const LONG_AGO = '2026-06-30T18:30:22.361510+00:00';

const stream = (over: Partial<StreamRefresh> = {}): StreamRefresh => ({
  lastChecked: RECENT,
  lastStoredRows: RECENT,
  delivery: 'flowing',
  pipelines: ['load'],
  ...over,
});

describe('describeRefresh — never prints a refresh time it did not measure', () => {
  it('says "Never", not the check time, when no pass has ever delivered', () => {
    // GB load: 453 completed passes, not one returned a row. It was checked
    // this morning. A UI that fell back to the check time would say GB's load
    // was refreshed two hours ago.
    const copy = describeRefresh(
      'load',
      stream({ lastStoredRows: null, delivery: 'never_delivered' }),
      null,
      NOW,
    );

    expect(copy.refreshed).toBe('Never');
    expect(copy.refreshed).not.toContain('ago');
    expect(copy.checked).toBe(
      'Checked 2 hours ago. No pass has ever stored a row for this country.',
    );
    expect(copy.attention).toBe(true);
  });

  it('dates the refresh from the last delivery, not the last check', () => {
    // AL generation: checked four times a day, last actually delivered
    // 2026-06-30, because Albania publishes no A75 document at all.
    const copy = describeRefresh(
      'generation',
      stream({ lastChecked: RECENT, lastStoredRows: LONG_AGO, delivery: 'checked_no_data' }),
      null,
      NOW,
    );

    // `formatDistanceStrict` rolls 42 days up to "1 month", matching the
    // header pill's own idiom. The point is that it dates from LONG_AGO at all
    // rather than from RECENT, not the precise wording of the interval.
    expect(copy.refreshed).toBe('1 month ago');
    expect(copy.checked).toBe('Checked 2 hours ago — that pass stored nothing.');
    expect(copy.attention).toBe(true);
  });

  it('reports a healthy stream without an attention mark', () => {
    const copy = describeRefresh('load', stream(), null, NOW);

    expect(copy.refreshed).toBe('2 hours ago');
    expect(copy.checked).toBe('Checked 2 hours ago.');
    expect(copy.attention).toBe(false);
  });

  it('distinguishes "the log cannot answer" from "never refreshed"', () => {
    // `not_logged` says nothing about whether the pipeline ran — the log simply
    // has no record. Rendering it as "Never" would assert an outage from an
    // absence of evidence, and the log only starts 2025-12-23.
    const copy = describeRefresh(
      'netPosition',
      stream({ lastChecked: null, lastStoredRows: null, delivery: 'not_logged' }),
      '2025-12-23T20:31:13.531371+00:00',
      NOW,
    );

    expect(copy.refreshed).toBe('Not recorded');
    expect(copy.refreshed).not.toBe('Never');
    expect(copy.checked).toContain('The ingest log starts 2025-12-23.');
    // Not an alarm: an absent record is not a failing pipeline.
    expect(copy.attention).toBe(false);
  });

  it('states the missing record even when the log start is unknown', () => {
    const copy = describeRefresh(
      'netPosition',
      stream({ lastChecked: null, lastStoredRows: null, delivery: 'not_logged' }),
      null,
      NOW,
    );

    expect(copy.refreshed).toBe('Not recorded');
    expect(copy.checked).toBe('No pass logged for this country.');
  });

  it('does not print a pass finishing in the future under clock skew', () => {
    const copy = describeRefresh(
      'load',
      stream({
        lastChecked: '2026-08-12T06:03:00.000000+00:00',
        lastStoredRows: '2026-08-12T06:03:00.000000+00:00',
      }),
      null,
      NOW,
    );

    expect(copy.refreshed).toBe('just now');
    expect(copy.checked).toBe('Checked just now.');
  });

  it('names each stream after the tab it is drawn on', () => {
    // "renewable" is the pipeline's name for the generation fetch; showing it
    // would point a user at a tab that no longer exists.
    expect(describeRefresh('generation', stream(), null, NOW).label).toBe('Generation');
    expect(describeRefresh('price', stream(), null, NOW).label).toBe('Day-ahead price');
    expect(describeRefresh('netPosition', stream(), null, NOW).label).toBe('Net position');
  });
});

describe('describeAllRefreshes', () => {
  const ingest: IngestFreshness = {
    load: stream(),
    price: stream(),
    generation: stream(),
    tsoLoadForecast: stream(),
    tsoGenerationForecast: stream(),
    netPosition: stream({ lastStoredRows: null, delivery: 'never_delivered' }),
    logStartsAt: '2025-12-23T20:31:13.531371+00:00',
  };

  it('returns every stream, in display order, so none is silently dropped', () => {
    const rows = describeAllRefreshes(ingest, NOW);

    expect(rows).toHaveLength(REFRESH_STREAM_ORDER.length);
    expect(rows.map((r) => r.label)).toEqual([
      'Load',
      'Day-ahead price',
      'Generation',
      'Net position',
      'TSO load forecast',
      'TSO wind/solar forecast',
    ]);
  });

  it('marks only the streams that are running without receiving anything', () => {
    const rows = describeAllRefreshes(ingest, NOW);
    expect(rows.filter((r) => r.attention).map((r) => r.label)).toEqual(['Net position']);
  });
});
