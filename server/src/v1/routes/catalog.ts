import { Router, type Request, type Response } from 'express';
import { ENTSOE_OBSERVATION, ABLE_FORECAST, type SeriesSource } from '../data/attribution.js';
import { buildLink } from '../data/links.js';
import { parseEnum, parseWindow, parseZone, toIsoSecond } from '../data/params.js';
import { readWindowCoverage, MAX_GAPS, type CoverageGap } from '../data/catalogRepo.js';
import { PUBLIC_FORECAST_TYPES } from '../data/models.js';
import { OBSERVATION_STREAMS, type ObservationStream } from '../data/series.js';
import type { V1DataContext } from '../data/context.js';

/**
 * `GET /v1/catalog/{zones,models,coverage}` — what we hold, stated rather than
 * inferred.
 *
 * ABL-293 §2a calls `/v1/catalog/coverage` **not optional**, and the reason is
 * the one failure mode a data API cannot fix inside a data response: *"It is the
 * endpoint that stops a customer inferring 'Albania had no load' from an empty
 * array when the truth is 'Albania stopped publishing upstream on 2026-08-06
 * 21:45'. Absence must be narrated, and a public API cannot narrate it inside a
 * data response without inventing rows."*
 *
 * A zone *list* would not do the job. `energy_load` covers 36 zones — and GB
 * stopped at 2021-06-14, UA at 2022-02-25, and MK has rows on 30 of 46 dates
 * including a seven-day hole. A list presents all of that as coverage. A span,
 * a status and enumerated gaps are what a customer can plan against.
 *
 * ## Why the envelope is lighter here
 *
 * These three return *metadata*, not a time series, so `meta` carries no
 * `from`/`to`, no `resolution` and no row cap — fields that would be null on
 * every response and would invite a client to branch on them. What it does carry
 * is `generated_at` and, per entry, the same `source` block the data endpoints
 * put on every series (ToS §7.3): a catalogue that told you a zone existed
 * without telling you whose data it was would push the licence question back
 * onto the customer at exactly the moment they are deciding what to buy.
 */

interface CatalogEnvelope<Row> {
  data: Row[];
  meta: {
    resource: string;
    row_count: number;
    /** When this payload was computed — the handler clock, as on every response. */
    generated_at: string;
    /**
     * When the memoized fleet map behind this response was built.
     *
     * Distinct from `generated_at` on purpose. The map refreshes once a minute,
     * so a catalogue response can be freshly computed from a map that is up to
     * that old, and saying so is cheaper than implying a per-request scan we
     * deliberately do not do (ABL-293 §2g.G: the per-zone lookup measured 103 ms
     * and the fleet grouping 250 ms, on a single-threaded process).
     */
    map_built_at: string;
  };
  links: { self: string; next: null };
}

export function catalogRouter(context: V1DataContext): Router {
  const router = Router();
  router.get('/zones', (req, res) => serveZones(context, req, res));
  router.get('/models', (req, res) => serveModels(context, req, res));
  router.get('/coverage', (req, res) => serveCoverage(context, req, res));
  return router;
}

interface ZoneStreamEntry {
  stream: ObservationStream;
  data_from: string | null;
  data_through: string | null;
  source_checked_at: string | null;
  status: string;
  source: SeriesSource;
}

/**
 * Every zone we hold, with the span and status of each observation stream.
 *
 * Zones with no rows in any stream are **kept**, with `status: "none"` on each.
 * Dropping them would answer "is XX a zone you cover" with silence, and a client
 * comparing our list against ENTSO-E's would have to guess whether an absence
 * meant "not covered" or "we forgot". `countries` holds 39 rows; the streams
 * reach 36, 34 and 30 of them, and this endpoint is where that difference is
 * visible.
 */
function serveZones(context: V1DataContext, _req: Request, res: Response): void {
  const snapshot = context.freshness.snapshot();

  const data = snapshot.zones.map((zone) => ({
    zone,
    streams: OBSERVATION_STREAMS.map((stream): ZoneStreamEntry => {
      const state = context.freshness.lookup(zone, stream);
      return {
        stream,
        data_from: state.data_from,
        data_through: state.data_through,
        source_checked_at: state.source_checked_at,
        status: state.status,
        source: ENTSOE_OBSERVATION,
      };
    }),
  }));

  res.json(
    envelope(context, 'catalog.zones', data, '/v1/catalog/zones', {}, snapshot.builtAt)
  );
}

/**
 * The forecast catalogue, filtered by **measured coverage**.
 *
 * ABL-293 §2a: two registered models (`catboost-retrain-v1`,
 * `xgboost-retrain-v1`) have zero rows, so a catalogue built from the registry
 * advertises models that return nothing. This one is a query over the rows —
 * a model with no rows cannot appear in the output of a `GROUP BY` over its
 * rows — so the filtering is a property of where the answer comes from rather
 * than a rule someone maintains.
 *
 * A type we offer but for which no model has written is omitted entirely rather
 * than listed with an empty zone array: an entry with no zones is an offer with
 * nothing behind it.
 */
function serveModels(context: V1DataContext, _req: Request, res: Response): void {
  const coverage = context.catalog.modelCoverage();

  const data = PUBLIC_FORECAST_TYPES.flatMap((type) =>
    coverage
      .filter((entry) => entry.forecast_type === type.id)
      .map((entry) => ({
        forecast_type: entry.forecast_type,
        model: entry.model,
        stability: entry.stability,
        unit: entry.unit,
        zone_count: entry.zones.length,
        zones: entry.zones,
        source: ABLE_FORECAST,
      }))
  );

  res.json(
    envelope(
      context,
      'catalog.models',
      data,
      '/v1/catalog/models',
      {},
      context.freshness.snapshot().builtAt
    )
  );
}

interface CoverageBody {
  zone: string;
  stream: ObservationStream;
  data_from: string | null;
  data_through: string | null;
  source_checked_at: string | null;
  status: string;
  source: SeriesSource;
  /** Present only when a window was asked for. */
  window?: {
    from: string;
    to: string;
    row_count: number;
    resolution: string | null;
    excluded_row_count: number;
    gaps: CoverageGap[];
    gaps_truncated: boolean;
    max_gaps: number;
  };
}

/**
 * Coverage of one zone and stream — the span always, the holes on request.
 *
 * `from`/`to` are **optional here**, unlike on the data endpoints. Without them
 * this answers the cheap question ("what period do you hold, and is it live")
 * from the memoized map. With them it answers the expensive one ("where exactly
 * are the holes") by reading the window's timestamps and reporting every gap
 * wider than the observed spacing.
 *
 * Both must be given together. One alone is a request that cannot be honoured
 * either way — guessing the other end is how a customer ends up billed for a
 * window they did not ask for.
 */
function serveCoverage(context: V1DataContext, req: Request, res: Response): void {
  const zone = parseZone(req.query.zone);
  const stream = parseEnum(req.query.stream, 'stream', OBSERVATION_STREAMS, {
    required: true,
  }) as ObservationStream;

  const state = context.freshness.lookup(zone, stream);
  const body: CoverageBody = {
    zone,
    stream,
    data_from: state.data_from,
    data_through: state.data_through,
    source_checked_at: state.source_checked_at,
    status: state.status,
    source: ENTSOE_OBSERVATION,
  };

  const hasFrom = req.query.from !== undefined;
  const hasTo = req.query.to !== undefined;
  if (hasFrom !== hasTo) {
    // `parseWindow` would say "both are required", which is the right message —
    // reached here by asking it, so the wording cannot drift from the data
    // endpoints'.
    parseWindow(req.query as Record<string, unknown>);
  }

  if (hasFrom && hasTo) {
    const window = parseWindow(req.query as Record<string, unknown>);
    const measured = readWindowCoverage(context.source, stream, zone, window);
    body.window = {
      from: window.fromIso,
      to: window.toIso,
      row_count: measured.row_count,
      resolution: measured.resolution,
      excluded_row_count: measured.excluded_row_count,
      gaps: measured.gaps,
      gaps_truncated: measured.gaps_truncated,
      max_gaps: MAX_GAPS,
    };
  }

  res.json(
    envelope(
      context,
      'catalog.coverage',
      [body],
      '/v1/catalog/coverage',
      {
        zone,
        stream,
        from: body.window?.from,
        to: body.window?.to,
      },
      context.freshness.snapshot().builtAt
    )
  );
}

function envelope<Row>(
  context: V1DataContext,
  resource: string,
  data: Row[],
  path: string,
  linkParams: Record<string, string | number | undefined>,
  mapBuiltAt: Date
): CatalogEnvelope<Row> {
  return {
    data,
    meta: {
      resource,
      row_count: data.length,
      generated_at: toIsoSecond(context.now()),
      map_built_at: toIsoSecond(mapBuiltAt),
    },
    links: { self: buildLink(context.publicBaseUrl, path, linkParams), next: null },
  };
}
