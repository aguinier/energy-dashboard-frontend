import db from '../config/database.js';
import {
  INGEST_PIPELINES,
  INGEST_PIPELINE_TYPES,
  INGEST_STREAM_KEYS,
  mergePipelinePasses,
  unloggedStream,
  type IngestFreshness,
  type PipelinePass,
} from './ingestLog.js';

/**
 * Per stream: when the ingest last ran for this country, and when a run last
 * brought a row back. See `ingestLog.ts` for why those are two numbers.
 *
 * ABL-295 made this the first read of `data_ingestion_log` in the repo; `/v1`'s
 * `data/freshnessMap.ts` is now a second, answering a narrower question off the
 * same table (see its module note, and ABL-637). Neither needs a schema change,
 * an ingest change or a backfill — the readonly handle already reaches it.
 */

interface PassRow {
  pipeline_type: string;
  last_checked: string | null;
  last_stored_rows: string | null;
}

/**
 * One grouped read over the whole (country, pipeline) space.
 *
 * The `end_time` filter sits in the WHERE and the delivered/not split sits in a
 * CASE, so the two maxima come out of a single pass over the same rows rather
 * than two round trips that could disagree.
 *
 * **`end_time IS NOT NULL` is the whole check test — `status` is not read.**
 * A pass that ran and errored still went and looked, and `status` is the one
 * column whose vocabulary the sibling module can widen without telling us; see
 * `ingestLog.ts` for the measurement that settled it (ABL-637). `end_time` is
 * written only by `log_ingestion_complete`, in the same UPDATE that sets a
 * terminal status, so its presence means "this pass finished" for every status
 * that exists now or later.
 *
 * `NOT INDEXED`, which is a hint *away* from every index rather than toward a
 * named one, so it stays valid whatever indexes the shared database carries.
 * The old query's speed came from the planner walking `idx_ingestion_log_status`
 * in rowid order; dropping the status predicate hands it
 * `idx_ingestion_log_pipeline(pipeline_type, start_time)` instead, whose row
 * lookups are random. Measured against the replica 2026-09-03 (143,336 rows),
 * FR across all seven pipelines, best of 7:
 *
 * | plan                                        | ms    |
 * |---------------------------------------------|-------|
 * | `NOT INDEXED` — plain scan                  | 20.0  |
 * | old `status = ?` (idx_ingestion_log_status) | 28.0  |
 * | planner's choice without the hint           | 126.2 |
 *
 * A sequential scan of a small table beats both index plans. Re-measure with
 * `EXPLAIN QUERY PLAN` on this statement if the table grows an order of
 * magnitude — it is ~1,200 rows/day.
 */
const PASSES_SQL = `
  SELECT pipeline_type,
         MAX(end_time) AS last_checked,
         MAX(CASE WHEN COALESCE(records_inserted, 0) + COALESCE(records_updated, 0) > 0
                  THEN end_time END) AS last_stored_rows
    FROM data_ingestion_log NOT INDEXED
   WHERE country_code = ?
     AND end_time IS NOT NULL
     AND pipeline_type IN (${INGEST_PIPELINE_TYPES.map(() => '?').join(', ')})
   GROUP BY pipeline_type
`;

export function getIngestFreshness(countryCode: string): IngestFreshness {
  const rows = db.prepare(PASSES_SQL).all(countryCode, ...INGEST_PIPELINE_TYPES) as PassRow[];

  const byPipeline = new Map<string, PassRow>(rows.map((r) => [r.pipeline_type, r]));

  const streams = Object.fromEntries(
    INGEST_STREAM_KEYS.map((key) => {
      const pipelines = INGEST_PIPELINES[key];
      const passes: PipelinePass[] = pipelines
        .map((pipelineType) => {
          const row = byPipeline.get(pipelineType);
          return row
            ? {
                pipelineType,
                lastChecked: row.last_checked,
                lastStoredRows: row.last_stored_rows,
              }
            : null;
        })
        .filter((p): p is PipelinePass => p !== null);

      // No pass on record is `not_logged`, never a zeroed-out `flowing`. The
      // log cannot distinguish "did not run" from "ran before the log existed",
      // and inventing either answer is the failure mode this endpoint is for.
      return [key, passes.length > 0 ? mergePipelinePasses(passes) : unloggedStream(pipelines)];
    }),
  ) as Omit<IngestFreshness, 'logStartsAt'>;

  return { ...streams, logStartsAt: getLogStart() };
}

/**
 * The earliest pass anywhere in the log, which bounds what `not_logged` can
 * mean. Whole-table `MIN` rather than per-country: the question is how far back
 * the log itself reaches, and a country whose own first pass is late would give
 * a bound that reads as its own history rather than the log's.
 */
function getLogStart(): string | null {
  const row = db
    .prepare('SELECT MIN(start_time) AS first_pass FROM data_ingestion_log')
    .get() as { first_pass: string | null } | undefined;

  return row?.first_pass ?? null;
}
