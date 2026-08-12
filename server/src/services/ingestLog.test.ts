import { describe, it, expect } from 'vitest';
import {
  INGEST_PIPELINES,
  INGEST_PIPELINE_TYPES,
  INGEST_STREAM_KEYS,
  classifyDelivery,
  mergePipelinePasses,
  passStoredRows,
  unloggedStream,
} from './ingestLog.js';

/**
 * ABL-295. The single property worth defending here is that "we ran" and "data
 * arrived" never collapse into each other. Every case below is taken from a
 * real (country, pipeline) pair measured on the replica 2026-08-12.
 */

const CHECKED = '2026-08-12T00:39:40.000000+00:00';
const EARLIER = '2026-06-30T18:30:22.361510+00:00';

describe('classifyDelivery — four states, four different claims', () => {
  it('calls it flowing only when the most recent pass brought rows', () => {
    // FR load, 2026-08-12: the 00:39 pass inserted, so both stamps are the same
    // instant. This is the only state where "last checked" is also "last
    // refreshed".
    expect(classifyDelivery(CHECKED, CHECKED)).toBe('flowing');
  });

  it('distinguishes "checked, nothing arrived" from a fresh refresh', () => {
    // AL renewable: checked at 00:30 today, last actually delivered
    // 2026-06-30 — Albania publishes no A75 document at all, so the passes keep
    // running and keep returning nothing. Showing only the check would claim a
    // 43-day-old series was refreshed this morning.
    expect(classifyDelivery(CHECKED, EARLIER)).toBe('checked_no_data');
  });

  it('separates "never delivered" from "delivered a while ago"', () => {
    // GB load: 453 completed passes on record, not one has ever brought a row.
    // There is no "last refreshed" to show at all, which is a different
    // sentence from a stale one — and must not render as a timestamp.
    expect(classifyDelivery(CHECKED, null)).toBe('never_delivered');
  });

  it('says the log cannot answer rather than inventing a verdict', () => {
    expect(classifyDelivery(null, null)).toBe('not_logged');
  });

  it('degrades an impossible ordering to flowing rather than an unhandled state', () => {
    // `lastStoredRows` maxes over a subset of `lastChecked`'s rows, so it cannot
    // legitimately exceed it. If a future caller passes something inconsistent,
    // fall through to the benign branch instead of returning undefined.
    expect(classifyDelivery(EARLIER, CHECKED)).toBe('flowing');
  });
});

describe('passStoredRows', () => {
  it('counts an insert or an update, and treats missing counters as zero', () => {
    expect(passStoredRows({ records_inserted: 24, records_updated: 0 })).toBe(true);
    expect(passStoredRows({ records_inserted: 0, records_updated: 7 })).toBe(true);
    expect(passStoredRows({ records_inserted: 0, records_updated: 0 })).toBe(false);
    expect(passStoredRows({ records_inserted: null, records_updated: null })).toBe(false);
  });

  it('still counts a partially failed pass that stored something', () => {
    // A pass that stored 24 rows and failed 2 did refresh the stream. Consulting
    // `records_failed` here would withhold a refresh that demonstrably happened.
    expect(passStoredRows({ records_inserted: 24, records_updated: 0 })).toBe(true);
  });
});

describe('mergePipelinePasses — one stream, several pipelines', () => {
  it('takes the newer of D+1 and D+7 for the table they both write', () => {
    // `load_forecast_day_ahead` and `_week_ahead` are separate passes writing
    // one table. If D+1 brought rows, `energy_load_forecast` was refreshed
    // whatever D+7 did — the stream describes the table, and the tab reads the
    // table.
    const merged = mergePipelinePasses([
      { pipelineType: 'load_forecast_day_ahead', lastChecked: CHECKED, lastStoredRows: CHECKED },
      { pipelineType: 'load_forecast_week_ahead', lastChecked: CHECKED, lastStoredRows: null },
    ]);

    expect(merged.lastStoredRows).toBe(CHECKED);
    expect(merged.delivery).toBe('flowing');
    expect(merged.pipelines).toEqual([
      'load_forecast_day_ahead',
      'load_forecast_week_ahead',
    ]);
  });

  it('does not let a never-delivering D+7 mark a refreshing table as stalled', () => {
    // The trap this merge exists for. D+7 finishes ~1s AFTER D+1 in every
    // cycle (FR, 2026-08-12: 00:39:16.351083 then 00:39:17.291833), so the
    // stream's max `lastChecked` is always D+7's and its max `lastStoredRows` is
    // always D+1's, one second earlier. Classifying those two maxima against
    // each other would report `checked_no_data` forever for the six countries
    // (BA GB MD MK SI UA) whose D+7 has never returned a row — on a table
    // their D+1 pass refreshes four times a day.
    const merged = mergePipelinePasses([
      {
        pipelineType: 'load_forecast_day_ahead',
        lastChecked: '2026-08-12T00:39:16.351083+00:00',
        lastStoredRows: '2026-08-12T00:39:16.351083+00:00',
      },
      {
        pipelineType: 'load_forecast_week_ahead',
        lastChecked: '2026-08-12T00:39:17.291833+00:00',
        lastStoredRows: null,
      },
    ]);

    expect(merged.delivery).toBe('flowing');
    // Both stamps are still reported verbatim — the later check is not hidden
    // just because the verdict came from the other pipeline.
    expect(merged.lastChecked).toBe('2026-08-12T00:39:17.291833+00:00');
    expect(merged.lastStoredRows).toBe('2026-08-12T00:39:16.351083+00:00');
  });

  it('prefers a stale delivery over a pipeline that never delivered', () => {
    // If D+1 last delivered a month ago and D+7 never has, the table WAS
    // refreshed a month ago. `checked_no_data` is the honest verdict;
    // `never_delivered` would deny a delivery that happened.
    const merged = mergePipelinePasses([
      { pipelineType: 'load_forecast_day_ahead', lastChecked: CHECKED, lastStoredRows: EARLIER },
      { pipelineType: 'load_forecast_week_ahead', lastChecked: CHECKED, lastStoredRows: null },
    ]);

    expect(merged.delivery).toBe('checked_no_data');
    expect(merged.lastStoredRows).toBe(EARLIER);
  });

  it('reports never_delivered only when NO contributing pipeline ever delivered', () => {
    // GB: both load-forecast passes run and neither has ever returned a row.
    const merged = mergePipelinePasses([
      { pipelineType: 'load_forecast_day_ahead', lastChecked: CHECKED, lastStoredRows: null },
      { pipelineType: 'load_forecast_week_ahead', lastChecked: CHECKED, lastStoredRows: null },
    ]);

    expect(merged.lastStoredRows).toBeNull();
    expect(merged.delivery).toBe('never_delivered');
  });

  it('compares the log\'s fixed-width UTC stamps chronologically', () => {
    // Every `end_time` is Python's `datetime.now(pytz.UTC).isoformat()` — 32
    // chars, always `+00:00`, measured across all 114,982 non-null values. A
    // single fixed-width form sorts chronologically as a string, so string
    // `max` is correct here. (This is NOT the two-separator hazard
    // `utils/timestamp.ts` exists for; that one has both `T` and space forms in
    // one column, where `'T' > ' '` makes a single bound wrong.)
    const merged = mergePipelinePasses([
      { pipelineType: 'a', lastChecked: '2026-08-12T00:09:00.000001+00:00', lastStoredRows: null },
      { pipelineType: 'b', lastChecked: '2026-08-12T00:10:00.000000+00:00', lastStoredRows: null },
    ]);

    expect(merged.lastChecked).toBe('2026-08-12T00:10:00.000000+00:00');
  });
});

describe('the pipeline map', () => {
  it('routes the generation stream through the pipeline named "renewable"', () => {
    // One A75 fetch writes both generation tables, and the pipeline is named
    // for the older frozen one. Naming this stream `renewable` on the wire
    // would point a user at a tab that no longer exists.
    expect(INGEST_PIPELINES.generation).toEqual(['renewable']);
  });

  it('omits pipelines with no client surface', () => {
    // `crossborder_flows` and the two weather pipelines are real and logged,
    // but nothing renders them — and weather is keyed by bidding zone (DK1/DK2)
    // where every ENTSO-E pipeline uses plain DK, so they are not per-country
    // rows in this endpoint's sense.
    expect(INGEST_PIPELINE_TYPES).not.toContain('crossborder_flows');
    expect(INGEST_PIPELINE_TYPES).not.toContain('weather_update');
    expect(INGEST_PIPELINE_TYPES).not.toContain('weather_forecast');
  });

  it('deduplicates the pipeline list used for the SQL IN clause', () => {
    expect(INGEST_PIPELINE_TYPES.length).toBe(new Set(INGEST_PIPELINE_TYPES).size);
  });

  it('covers every stream key with at least one pipeline', () => {
    expect(INGEST_STREAM_KEYS.length).toBeGreaterThan(0);
    for (const key of INGEST_STREAM_KEYS) {
      expect(INGEST_PIPELINES[key].length).toBeGreaterThan(0);
    }
  });
});

describe('unloggedStream', () => {
  it('is null-valued and not_logged, never a zeroed-out flowing', () => {
    expect(unloggedStream(['net_position'])).toEqual({
      lastChecked: null,
      lastStoredRows: null,
      delivery: 'not_logged',
      pipelines: ['net_position'],
    });
  });
});
