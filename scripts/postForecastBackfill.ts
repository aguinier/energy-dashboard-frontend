/**
 * One-off backfill poster for ABL-240 / ABL-239.
 *
 * Posts the Forecasting Scientist's evidence-pack prediction files (ABL-239 —
 * ABL-195's retrained wind_onshore/wind_offshore artifacts, backfilled over
 * the gate-read window) through `POST /forecasts/net-position`, generalized
 * under ABL-240 to accept `forecast_type`.
 *
 * This is a one-time backfill, not a standing job — there is no cron, no
 * package.json script entry, and no expectation this file runs again once
 * ABL-240's backfill has landed. Re-running it with the same manifest is
 * harmless: the ingest deletes and re-inserts every row for a matching
 * (forecast_type, model_name, generated_at, country) rather than appending
 * (`server/src/services/netPositionIngestService.ts:63-98`), so a second run
 * converges on the same rows. Nothing schedules it.
 *
 * (Under ABL-240 that idempotency claim was true of the ingest but false of
 * this script: its own guard refused any model_name registered in
 * forecastModels.ts, and ABL-240 registered `catboost-retrain-v1` /
 * `xgboost-retrain-v1` in the same merge — so every re-run died before posting.
 * ABL-244 narrowed the guard to the production model_name only; see
 * `backfillModelGuard.ts`.)
 *
 * Usage:
 *   npx tsx scripts/postForecastBackfill.ts --manifest <path/to/manifest.json> [--execute]
 *
 * Without --execute this only validates and prints a summary (dry run).
 * With --execute it actually POSTs, reading HELIO_WRITE_TOKEN from the
 * environment (never pass it on the command line — it would land in shell
 * history). API_BASE_URL defaults to http://localhost:3001/api; point it at
 * production only once the local dry run and a local-server smoke test both
 * look right.
 *
 * Expects a manifest shaped like ABL-239's
 * (energy-forecast/experiments/ABL239/manifest.json):
 *   {
 *     "outputs": [
 *       { "forecast_type": "wind_offshore", "output_path": "...",
 *         "payload_sha256": "...", "model_name": "...", "model_version": "..." },
 *       ...
 *     ]
 *   }
 * Each output_path must point at a JSON file shaped like the ingest payload
 * (model, generated_at, rows[]) — see server/src/routes/netPositionIngest.ts —
 * minus forecast_type, which this script injects from the manifest entry.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { checkBackfillModelName } from './backfillModelGuard.js';

const WIND_FORECAST_TYPES = new Set(['wind_onshore', 'wind_offshore']);

interface ManifestOutput {
  forecast_type: string;
  output_path: string;
  payload_sha256: string;
  model_name: string;
  model_version: string;
  row_count?: number;
}

interface Manifest {
  outputs: ManifestOutput[];
}

interface IngestRow {
  country_code: string;
  target_timestamp_utc: string;
  horizon_hours: number;
  forecast_value: number;
  quantiles?: Record<string, number>;
}

interface IngestFile {
  model: { name: string; version: string };
  generated_at: string;
  rows: IngestRow[];
}

function parseArgs(argv: string[]) {
  const manifestFlagIndex = argv.indexOf('--manifest');
  if (manifestFlagIndex === -1 || !argv[manifestFlagIndex + 1]) {
    throw new Error('Usage: postForecastBackfill.ts --manifest <path/to/manifest.json> [--execute]');
  }
  return {
    manifestPath: resolve(argv[manifestFlagIndex + 1]),
    execute: argv.includes('--execute'),
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Refuse to post under the forecast_type's PRODUCTION model_name, which the
 * ingest would overwrite. A registered shadow candidate is the intended target,
 * not a clash — see `backfillModelGuard.ts` for why.
 */
function assertModelNamePostable(forecastType: string, modelName: string): void {
  const check = checkBackfillModelName(forecastType, modelName);
  if (!check.ok) throw new Error(check.message);
  if (check.note) console.log(`  NOTE: ${check.note}`);
}

async function postOne(apiBase: string, token: string, forecastType: string, file: IngestFile): Promise<void> {
  const body = JSON.stringify({ forecast_type: forecastType, ...file });
  const res = await fetch(`${apiBase}/forecasts/net-position`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`POST failed for ${forecastType} (${res.status}): ${JSON.stringify(json)}`);
  }
  console.log(`  -> ${forecastType}: ${JSON.stringify(json.data)}`);
}

async function main(): Promise<void> {
  const { manifestPath, execute } = parseArgs(process.argv.slice(2));

  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.outputs) || manifest.outputs.length === 0) {
    throw new Error(`No outputs[] found in ${manifestPath}`);
  }

  console.log(`Manifest: ${manifestPath}`);
  console.log(`${manifest.outputs.length} output(s) to process.\n`);

  const prepared: Array<{ forecastType: string; file: IngestFile; modelName: string }> = [];

  for (const output of manifest.outputs) {
    if (!WIND_FORECAST_TYPES.has(output.forecast_type)) {
      throw new Error(
        `forecast_type '${output.forecast_type}' is outside this script's scope (${[...WIND_FORECAST_TYPES].join(', ')}). ` +
        `This script is the ABL-240/ABL-239 wind backfill poster, not a general-purpose ingest client.`
      );
    }

    const raw = readFileSync(output.output_path, 'utf8');
    const actualHash = sha256(raw);
    if (actualHash !== output.payload_sha256) {
      throw new Error(
        `SHA-256 mismatch for ${output.output_path}: manifest says ${output.payload_sha256}, ` +
        `file hashes to ${actualHash}. Refusing to post a payload that does not match its manifest.`
      );
    }

    const file: IngestFile = JSON.parse(raw);
    if (file.model.name !== output.model_name || file.model.version !== output.model_version) {
      throw new Error(
        `Manifest/payload model mismatch for ${output.forecast_type}: manifest says ` +
        `${output.model_name}/${output.model_version}, payload says ${file.model.name}/${file.model.version}.`
      );
    }
    if (!Array.isArray(file.rows) || file.rows.length === 0) {
      throw new Error(`No rows in ${output.output_path}`);
    }
    if (file.rows.length > 5000) {
      throw new Error(
        `${output.forecast_type} has ${file.rows.length} rows, over the server's 5000-row cap per post. ` +
        `Split it before posting (the server route has never needed this — ABL-239's two files are ` +
        `1,440 and 2,160 rows respectively).`
      );
    }

    const countries = [...new Set(file.rows.map((r) => r.country_code))].sort();
    console.log(`${output.forecast_type}:`);
    console.log(`  model_name=${output.model_name} model_version=${output.model_version}`);
    console.log(`  rows=${file.rows.length} countries=${countries.join(',')}`);
    console.log(`  sha256 verified against manifest: OK`);
    assertModelNamePostable(output.forecast_type, output.model_name);

    prepared.push({ forecastType: output.forecast_type, file, modelName: output.model_name });
  }

  if (!execute) {
    console.log('\nDry run only (no --execute passed). Nothing was posted.');
    return;
  }

  const token = process.env.HELIO_WRITE_TOKEN;
  if (!token) {
    throw new Error('HELIO_WRITE_TOKEN is not set in the environment. Refusing to post without it.');
  }
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:3001/api';

  console.log(`\nPosting to ${apiBase} ...`);
  for (const { forecastType, file } of prepared) {
    await postOne(apiBase, token, forecastType, file);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
