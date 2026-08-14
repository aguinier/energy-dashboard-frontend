import db from '../config/database.js';
import {
  INGEST_COMPLETED_STATUS,
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
 * `data_ingestion_log` is read here for the first time in this repo's history.
 * It needs no schema change, no ingest change and no backfill — the readonly
 * handle already reaches it.
 */

interface PassRow {
  pipeline_type: string;
  last_checked: string | null;
  last_stored_rows: string | null;
}

/**
 * One grouped read over the whole (country, pipeline) space.
 *
 * The `status`/`end_time` filters sit in the WHERE and the delivered/not split
 * sits in a CASE, so the two maxima come out of a single pass over the same
 * rows rather than two round trips that could disagree.
 *
 * No `INDEXED BY` hint, deliberately. SQLite picks `idx_ingestion_log_status`,
 * which is barely selective (114,982 of 114,983 rows are `completed`) and so
 * amounts to a scan — but the table is small and that scan is sequential.
 * Measured against the replica 2026-08-12, FR across all seven pipelines:
 * **38 ms** letting the planner choose, against **133 ms** when forced onto
 * `idx_ingestion_log_pipeline`, whose row lookups are random. Forcing the
 * "better looking" index is 3.5x slower here; leave it alone.
 */
const PASSES_SQL = `
  SELECT pipeline_type,
         MAX(end_time) AS last_checked,
         MAX(CASE WHEN COALESCE(records_inserted, 0) + COALESCE(records_updated, 0) > 0
                  THEN end_time END) AS last_stored_rows
    FROM data_ingestion_log
   WHERE country_code = ?
     AND status = ?
     AND end_time IS NOT NULL
     AND pipeline_type IN (${INGEST_PIPELINE_TYPES.map(() => '?').join(', ')})
   GROUP BY pipeline_type
`;

export function getIngestFreshness(countryCode: string): IngestFreshness {
  const rows = db
    .prepare(PASSES_SQL)
    .all(countryCode, INGEST_COMPLETED_STATUS, ...INGEST_PIPELINE_TYPES) as PassRow[];

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
