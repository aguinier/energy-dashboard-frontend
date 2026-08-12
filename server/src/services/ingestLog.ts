/**
 * When did we last *refresh* a stream — and did anything actually arrive?
 *
 * ABL-295, follow-up A from the ABL-286 provenance audit.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The dashboard has never been able to answer "when was this last refreshed"
 * honestly. The obvious column lies: `publication_timestamp_utc` is filled from
 * the ENTSO-E response's `createdDateTime`, and ENTSO-E builds its documents
 * *on request*, so the column records when **we fetched**, not when anybody
 * published. The audit measured how far that drifts — `energy_generation` FR
 * target `2021-01-01 12:00` carries a "publication" stamp of `2026-07-29
 * 16:04:20`, and 80.4% of `energy_load` rows carry one more than a day newer
 * than the row holding it (max drift 39.1 days). CLAUDE.md forbids building on
 * it or backfilling it, and this module does neither.
 *
 * `data_ingestion_log` is the honest source, and until now nothing in this repo
 * read it (`grep -rn data_ingestion_log server/src client/src` returned
 * nothing). It records one row per (pipeline, country, pass) with the pass's own
 * `end_time` and what it brought back. That answers a genuinely different
 * question from `services/freshness.ts`: that module asks *how old is the newest
 * row we hold*, this one asks *when did we last go and look*. Both are true at
 * once and neither implies the other — which is the whole point below.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID
 *
 * A `completed` pass does **not** mean data arrived. Measured on the replica
 * 2026-08-12 (identical to the issue's prod figures): of 16,335 completed
 * `price` passes, 2,886 inserted and updated exactly nothing; `load` 1,367 of
 * 16,301; `load_forecast_week_ahead` 4,119 of 16,298; `net_position` 1,267 of
 * 2,668.
 *
 * Per (country, pipeline) that is not a rounding error, it is the common case
 * for whole streams. Measured the same day:
 *
 * - `net_position` — **14 of 36 countries have never had a single pass bring a
 *   row** (AL BA CH CY DK GB IT MD ME MK NO RS SE UA), and GR and IE last got
 *   one on 2026-07-31.
 * - `load` — GB and UA have never had one, matching their long-dead series
 *   (GB stops 2021-06-14, UA 2022-02-25).
 * - `renewable` — AL last got one on 2026-06-30, which is the generation gap
 *   CLAUDE.md already documents as permanent (Albania publishes no A75).
 * - `load_forecast_week_ahead` — ME last got one on 2026-05-24; BA, GB, MD, MK,
 *   SI and UA never have.
 *
 * Every one of those countries was "checked" during the 00:30-00:48 UTC pass on
 * 2026-08-12, minutes before the measurement. So a UI that showed only the last
 * pass time would tell a GB user their load was refreshed this morning, when in
 * fact no pass has ever returned a GB load row. That is this repo's signature
 * defect — a confidently wrong number — so the two values are kept separate all
 * the way to the screen and are never collapsed into one.
 *
 * WHAT THIS SOURCE CANNOT TELL YOU — READ BEFORE BUILDING ON IT
 *
 * `records_inserted` counts rows **written**, not rows that are new. The ingest
 * re-fetches a rolling 7-day window every pass and upserts everything it gets,
 * and `INSERT OR REPLACE` counts a rewrite of an existing row as an insert. So
 * `lastStoredRows` is NOT evidence that the series advanced.
 *
 * Measured on the replica 2026-08-12, AL `load` is the live proof: its
 * `MAX(timestamp_utc)` has been frozen at `2026-08-06 21:45` since the upstream
 * stall CLAUDE.md documents (ABL-84), and yet every pass since reports rows
 * stored — 660, 636, 608, 588, ... 180, falling monotonically as the rolling
 * window slides forward past the frozen data. Under this module AL load reads
 * `flowing`, and that is the correct description of *the pipeline*: it ran, it
 * wrote rows. It is not a claim about the data, and no caller may promote it to
 * one.
 *
 * The field is therefore named `lastStoredRows` and not `lastNewData`. The
 * question "how old is the data" is `services/freshness.ts`'s, answered from
 * `MAX(timestamp_utc)`; the client shows this panel behind that verdict and
 * says so in `REFRESH_PANEL_CAPTION`.
 *
 * (`records_updated` would be the natural place to separate a rewrite from a
 * genuine insert, but the sibling writer never sets it — measured 2026-08-12,
 * 0 of 114,983 rows carry a non-zero value, against 99,138 with a non-zero
 * `records_inserted`. Distinguishing the two is an ingest-side change, out of
 * scope here and forbidden from this repo.)
 *
 * Pure, with a colocated test, so the classification can be pinned without a
 * database or a clock.
 */

import type {
  IngestDelivery,
  IngestStreamKey,
  PipelinePass,
  StreamRefresh,
} from '../types/index.js';

export type {
  IngestDelivery,
  IngestFreshness,
  IngestStreamKey,
  PipelinePass,
  StreamRefresh,
} from '../types/index.js';

/**
 * Which `pipeline_type` values feed each stream the dashboard draws.
 *
 * Read off the sibling ingest module's own call sites rather than inferred from
 * the names, because two of them do not match the table they write:
 *
 * | pipeline_type                                     | writes                       | call site |
 * |---------------------------------------------------|------------------------------|-----------|
 * | `load`                                            | `energy_load`                | `../energy-data-gathering/src/fetch_load.py:93` |
 * | `price`                                           | `energy_price`               | `../energy-data-gathering/src/fetch_price.py:93` |
 * | `renewable`                                       | `energy_generation` **and** `energy_renewable` | `../energy-data-gathering/src/fetch_renewable.py:126` |
 * | `load_forecast_day_ahead` / `_week_ahead`         | `energy_load_forecast`       | `../energy-data-gathering/src/fetch_load_forecast.py:106` |
 * | `wind_solar_forecast`                             | `energy_generation_forecast` | `../energy-data-gathering/src/fetch_wind_solar_forecast.py:95` |
 * | `net_position`                                    | `net_position`               | `../energy-data-gathering/src/fetch_net_position.py` |
 *
 * Two mappings are worth stating out loud:
 *
 * - **`generation` is fed by the pipeline called `renewable`.** One A75 fetch
 *   per country per window writes both generation tables (CLAUDE.md, "Generation
 *   data"; `fetch_renewable.py` -> `query_generation_and_renewable_with_metadata`),
 *   so the pipeline named for the older frozen table is the one that refreshes
 *   the table `GenerationTab` actually draws. Naming this stream `renewable` on
 *   the wire would point a user at the wrong tab.
 * - **`tsoLoadForecast` is fed by TWO pipelines.** D+1 and D+7 are separate
 *   passes writing one table, so the stream's answer is the newer of the two:
 *   if the D+1 pass brought rows, `energy_load_forecast` was refreshed, whatever
 *   D+7 did. Merging with `max` is therefore correct *for the table*, and it is
 *   the table the tab reads.
 *
 * Deliberately absent: `crossborder_flows` (no client surface renders it),
 * and `weather_update` / `weather_forecast` (also unrendered, and keyed by
 * bidding zone — the log carries `DK1`/`DK2` for weather where every ENTSO-E
 * pipeline carries plain `DK`, so they are not per-country rows in this
 * endpoint's sense). This map covers what the dashboard draws; it is not an
 * inventory of the pipeline.
 */
export const INGEST_PIPELINES: Record<IngestStreamKey, readonly string[]> = {
  load: ['load'],
  price: ['price'],
  generation: ['renewable'],
  tsoLoadForecast: ['load_forecast_day_ahead', 'load_forecast_week_ahead'],
  tsoGenerationForecast: ['wind_solar_forecast'],
  netPosition: ['net_position'],
};

/** Every stream key, in the order the client renders them. */
export const INGEST_STREAM_KEYS = Object.keys(INGEST_PIPELINES) as IngestStreamKey[];

/** Every `pipeline_type` this endpoint reads, deduplicated — for the SQL `IN`. */
export const INGEST_PIPELINE_TYPES: readonly string[] = [
  ...new Set(Object.values(INGEST_PIPELINES).flat()),
];

/**
 * The status a pass row must carry to count as a check.
 *
 * The sibling writer sets `"failed" if error_message else "completed"`
 * (`../energy-data-gathering/src/db.py:1192`), so `failed` is producible even
 * though **no row has ever carried it** — measured 2026-08-12, all 114,983 rows
 * are `completed` bar the single in-flight `running` one. A failed pass is
 * deliberately neither a check nor a delivery here: counting it would let a
 * stream that has been erroring four times a day report itself as freshly
 * checked, which errs in the one direction this module must not err in.
 */
const COMPLETED = 'completed';

export { COMPLETED as INGEST_COMPLETED_STATUS };

/**
 * Did this pass write any rows?
 *
 * Deliberately NOT "did new data arrive" — see the header. `records_updated` is
 * summed in because that is what the column means, even though the writer has
 * never set it (0 of 114,983 rows), so the rule stays correct if it ever starts.
 *
 * `records_failed` is deliberately not consulted: a pass that stored 24 rows
 * and failed 2 still wrote to the table, and a pass that failed everything
 * already has `inserted + updated = 0`.
 */
export function passStoredRows(pass: {
  records_inserted: number | null;
  records_updated: number | null;
}): boolean {
  return (pass.records_inserted ?? 0) + (pass.records_updated ?? 0) > 0;
}

/**
 * How favourable each verdict is, best first. Used to fold several pipelines
 * writing one table into a single verdict — see `mergePipelinePasses`.
 */
const DELIVERY_RANK: readonly IngestDelivery[] = [
  'flowing',
  'checked_no_data',
  'never_delivered',
  'not_logged',
];

/**
 * Fold one stream's pipelines into a single answer.
 *
 * The two timestamps are plain maxima — the last time ANY contributing pipeline
 * ran, and the last time ANY of them put a row in the table. Both describe the
 * table, which is what the tab reads.
 *
 * THE VERDICT IS **NOT** `classifyDelivery(maxChecked, maxNewData)`, AND THAT
 * DISTINCTION IS THE WHOLE REASON THIS FUNCTION EXISTS.
 *
 * Comparing maxima taken from different pipelines compares apples to oranges.
 * `load_forecast_day_ahead` and `load_forecast_week_ahead` run seconds apart in
 * every cycle, week-ahead second — measured on the replica 2026-08-12, FR
 * finished D+1 at `00:39:16.351083` and D+7 at `00:39:17.291833`. Six of 36
 * countries (BA, GB, MD, MK, SI, UA) have a D+7 pass that has never once
 * returned a row while their D+1 pass delivers normally. Under the naive
 * comparison, `maxChecked` is always D+7's stamp and `maxNewData` is always
 * D+1's, one second earlier — so those countries would report
 * `checked_no_data` **forever**, on a table that is in fact refreshed four
 * times a day. Reporting a healthy stream as not-refreshing is the same class
 * of false claim as the reverse, just pointed the other way.
 *
 * So each pipeline is classified against its OWN pair of stamps, and the stream
 * takes the most favourable verdict: if any one pipeline's latest pass
 * delivered, the table was refreshed, whatever the others did.
 *
 * Timestamps are compared as strings, which is safe here and only here:
 * `data_ingestion_log` writes one format and one only — Python's
 * `datetime.now(pytz.UTC).isoformat()`, measured 2026-08-12 as 114,982 of
 * 114,982 non-null `end_time` values in the exact form
 * `2026-08-12T00:48:15.882895+00:00`, all 32 characters, all `+00:00`. This is
 * NOT the two-separator hazard `server/src/utils/timestamp.ts` exists for: that
 * one is about columns holding both `T` and space forms, where `'T' > ' '`
 * makes a single bound wrong. A single fixed-width UTC form sorts
 * chronologically as a string.
 */
export function mergePipelinePasses(passes: readonly PipelinePass[]): StreamRefresh {
  const perPipeline = passes.map((p) => classifyDelivery(p.lastChecked, p.lastStoredRows));
  const best = DELIVERY_RANK.find((d) => perPipeline.includes(d)) ?? 'not_logged';

  return {
    lastChecked: maxOrNull(passes.map((p) => p.lastChecked)),
    lastStoredRows: maxOrNull(passes.map((p) => p.lastStoredRows)),
    delivery: best,
    pipelines: passes.map((p) => p.pipelineType).sort(),
  };
}

/**
 * The four states, which are four different claims and must not be collapsed.
 *
 * - `flowing` — the most recent completed pass brought rows. The only state in
 *   which "last refreshed" and "last checked" are the same instant.
 * - `checked_no_data` — we have run since the last delivery and got nothing.
 *   Legitimate (a day-ahead auction publishes once, later passes re-read the
 *   same rows and change none) *and* the shape of a real outage. This endpoint
 *   reports both timestamps and does not adjudicate between them.
 * - `never_delivered` — passes are recorded and not one has ever brought a row.
 *   GB and UA load, and 14 of 36 zones' net position. Emphatically not the same
 *   as `checked_no_data`: there is no "last refreshed" to show at all.
 * - `not_logged` — no completed pass is recorded. This says nothing about
 *   whether the stream ran; it says the log cannot answer. The log starts
 *   2025-12-23, so it is silent about everything before that, which is why the
 *   response carries `logStartsAt` beside the streams.
 */
export function classifyDelivery(
  lastChecked: string | null,
  lastStoredRows: string | null,
): IngestDelivery {
  if (!lastChecked) return 'not_logged';
  if (!lastStoredRows) return 'never_delivered';
  return lastStoredRows < lastChecked ? 'checked_no_data' : 'flowing';
}

/** The stream shape for a (country, stream) pair with no pass on record. */
export function unloggedStream(pipelines: readonly string[]): StreamRefresh {
  return {
    lastChecked: null,
    lastStoredRows: null,
    delivery: 'not_logged',
    pipelines: [...pipelines].sort(),
  };
}

function maxOrNull(values: readonly (string | null)[]): string | null {
  let max: string | null = null;
  for (const v of values) {
    if (v !== null && (max === null || v > max)) max = v;
  }
  return max;
}
