import { Router, type Request, type Response } from 'express';
import {
  describeSeries,
  observeResolution,
  type Coverage,
  type Envelope,
} from '../data/envelope.js';
import { classifyForecastVintage, toWireInstant } from '../data/freshnessMap.js';
import { buildLink } from '../data/links.js';
import { decodeCursor, encodeCursor, queryFingerprint } from '../data/cursor.js';
import {
  parseEnum,
  parseHorizon,
  parseLimit,
  parseWindow,
  parseZone,
  toIsoSecond,
} from '../data/params.js';
import {
  readForecastEdges,
  readForecasts,
  readLatestVintage,
  resolveServingModel,
  type ForecastRow,
} from '../data/forecastsRepo.js';
import { PUBLIC_FORECAST_MODELS, PUBLIC_FORECAST_TYPE_IDS } from '../data/models.js';
import { forecastSeries } from '../data/series.js';
import { createVersionGate, type VersionGate } from '../modelVersions/versionGuard.js';
import type { V1DataContext } from '../data/context.js';

/**
 * `GET /v1/forecasts` and `GET /v1/forecasts/latest` — our own model output.
 *
 * This is the half of the product that is ours (ToS §2: *Forecast Output …
 * Our intellectual property*), and every response says so through the same
 * per-series source field the ENTSO-E observations carry — marked as ours, with
 * `attribution_required: false`, so a subscriber can tell the two apart
 * mechanically rather than by remembering which endpoint they called.
 *
 * Three constraints are published rather than left to be discovered, because
 * each is something a customer could otherwise buy a plan expecting:
 *
 * - **The horizon stops at D+2.** `MAX(horizon_hours)` across every model is 64.
 *   There is no D+3 and we do not manufacture one; a plan sold on "week-ahead
 *   forecasting" would be selling the TSO's number, which is not ours.
 * - **The history is ~7.5 months deep.** The earliest row of any type is
 *   2025-12-26. A customer backtesting against two years cannot.
 * - **Coverage is per type and per zone**, and thin for six of the eight types
 *   offered. `/v1/catalog/models` publishes the actual zone list per type and
 *   model, measured rather than declared.
 *
 * `net_position` is not among the served types and does not become one because
 * the JAO authorisation question closed: Board decision 2 is the remaining gate,
 * and it is open.
 */

export function forecastsRouter(context: V1DataContext): Router {
  const router = Router();
  router.get('/', (req, res) => serveForecasts(context, req, res));
  router.get('/latest', (req, res) => serveLatest(context, req, res));
  return router;
}

interface ForecastMetaExtras {
  forecast_type: string;
  model: string | null;
  horizon_hours: number | null;
  latest_vintage_at: string | null;
}

function serveForecasts(context: V1DataContext, req: Request, res: Response): void {
  const zone = parseZone(req.query.zone);
  const forecastType = parseEnum(req.query.type, 'type', PUBLIC_FORECAST_TYPE_IDS, {
    required: true,
  }) as string;
  const window = parseWindow(req.query as Record<string, unknown>);
  const limit = parseLimit(req.query.limit);
  const horizonHours = parseHorizon(req.query.horizon);
  const requestedModel = parseEnum(req.query.model, 'model', PUBLIC_FORECAST_MODELS, {
    required: false,
  });

  // Built per request, not per process: an acknowledgement matures at its own
  // instant, and a gate resolved at startup would keep withholding a cleared
  // artifact until someone restarted the server (ABL-529).
  const gate = createVersionGate(context.acknowledgedVersions, context.now());

  // An explicit model is honoured strictly; an absent one resolves to the first
  // served model that actually has rows for this zone, type and window.
  // catboost and xgboost cover disjoint zone sets — `load` is xgboost for
  // AT/BE/FR and catboost for the other 21 — so a hard pin would blank three
  // zones rather than harmonise them, and a silent substitution under an
  // explicit request would answer a question nobody asked.
  const model =
    requestedModel ?? resolveServingModel(context.source, zone, forecastType, window, gate) ?? null;

  const path = '/v1/forecasts';
  const fingerprint = queryFingerprint(path, {
    zone,
    type: forecastType,
    from: window.fromIso,
    to: window.toIso,
    limit,
    horizon: horizonHours ?? '',
    // The *resolved* model, so a cursor minted while catboost was serving is
    // refused if the resolution later changes. Page two of a catboost series
    // must never silently become xgboost.
    model: model ?? '',
  });
  const after = decodeCursor(req.query.cursor, fingerprint);

  const page =
    model === null
      ? { rows: [] as ForecastRow[], lastStoredTimestamp: null, hasMore: false }
      : readForecasts(context.source, {
          zone,
          forecastType,
          model,
          window,
          horizonHours,
          after,
          limit,
          gate,
        });

  const edges =
    model === null
      ? { newestTarget: null, newestVintage: null }
      : readForecastEdges(context.source, zone, forecastType, model, gate);

  const linkParams = {
    zone,
    type: forecastType,
    from: window.fromIso,
    to: window.toIso,
    limit,
    horizon: horizonHours,
    model: requestedModel,
  };

  const body: Envelope<ForecastRow> & { meta: ForecastMetaExtras } = {
    data: page.rows,
    meta: {
      resource: 'forecasts',
      zone,
      forecast_type: forecastType,
      model,
      horizon_hours: horizonHours ?? null,
      from: window.fromIso,
      to: window.toIso,
      coverage: forecastCoverage(page.rows.length, edges.newestVintage),
      row_count: page.rows.length,
      row_limit: limit,
      truncated: page.hasMore,
      ...observeResolution(page.rows.map((row) => row.timestamp)),
      series: describeSeries([forecastSeries(forecastType)]),
      latest_vintage_at: toWireInstant(edges.newestVintage),
      freshness: {
        // How far ahead we reach for this series — the forecast analogue of
        // "newest row we hold", and legitimately in the future.
        data_through: toWireInstant(edges.newestTarget),
        // Null and not an omission: this series has no upstream pass to have
        // checked. It is ours, produced by our own runs, and pointing this at
        // the ENTSO-E ingest that fed the model's features would be answering a
        // question about a different thing.
        source_checked_at: null,
        status: classifyForecastVintage(edges.newestVintage, context.now()),
        generated_at: toIsoSecond(context.now()),
      },
    },
    links: {
      self: buildLink(context.publicBaseUrl, path, {
        ...linkParams,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      }),
      next:
        page.hasMore && page.lastStoredTimestamp !== null
          ? buildLink(context.publicBaseUrl, path, {
              ...linkParams,
              cursor: encodeCursor(fingerprint, page.lastStoredTimestamp),
            })
          : null,
    },
  };

  res.json(body);
}

/**
 * Why a forecast page is empty.
 *
 * `upstream_gap` is deliberately never returned here. There is no upstream for
 * our own model output — a hole in it would be *our* run that did not happen —
 * and borrowing the word would tell a customer to go and ask ENTSO-E about a
 * gap we caused. So the two answers are: we hold nothing for this zone, type
 * and model at all (`out_of_scope`, and no window will help), or we hold the
 * series and this window is empty (`no_data`).
 */
function forecastCoverage(rowCount: number, newestVintage: string | null): Coverage {
  if (rowCount > 0) return 'ok';
  return newestVintage === null ? 'out_of_scope' : 'no_data';
}

/**
 * `GET /v1/forecasts/latest` — the newest complete run, whole.
 *
 * Takes no window and cannot be paged: one vintage is bounded by the horizon, so
 * at most 64 rows. It is the newest *run* rather than the newest value per
 * target hour, because stitching several runs together produces a series with
 * discontinuities at the seams that no model ever emitted — see
 * `forecastsRepo.ts`.
 *
 * `generated_at` on every row is what makes this endpoint honest at 03:00 UTC,
 * when the newest vintage is eight hours old because our runs stop at 19:00 and
 * resume at 07:00. The forecast is not stale; the silence about its age would
 * have been.
 */
function serveLatest(context: V1DataContext, req: Request, res: Response): void {
  const zone = parseZone(req.query.zone);
  const forecastType = parseEnum(req.query.type, 'type', PUBLIC_FORECAST_TYPE_IDS, {
    required: true,
  }) as string;
  const requestedModel = parseEnum(req.query.model, 'model', PUBLIC_FORECAST_MODELS, {
    required: false,
  });

  const gate = createVersionGate(context.acknowledgedVersions, context.now());
  const model = requestedModel ?? firstModelWithRows(context, zone, forecastType, gate);
  const rows =
    model === null ? [] : readLatestVintage(context.source, zone, forecastType, model, gate);
  const edges =
    model === null
      ? { newestTarget: null, newestVintage: null }
      : readForecastEdges(context.source, zone, forecastType, model, gate);

  const path = '/v1/forecasts/latest';
  const body: Envelope<ForecastRow> & { meta: ForecastMetaExtras } = {
    data: rows,
    meta: {
      resource: 'forecasts.latest',
      zone,
      forecast_type: forecastType,
      model,
      horizon_hours: null,
      // The window a vintage covers is a property of the run, not of the
      // request — so it is reported from the rows rather than echoed from
      // parameters this endpoint does not take.
      from: rows.length > 0 ? rows[0].timestamp : toIsoSecond(context.now()),
      to: rows.length > 0 ? rows[rows.length - 1].timestamp : toIsoSecond(context.now()),
      coverage: forecastCoverage(rows.length, edges.newestVintage),
      row_count: rows.length,
      row_limit: rows.length,
      truncated: false,
      ...observeResolution(rows.map((row) => row.timestamp)),
      series: describeSeries([forecastSeries(forecastType)]),
      latest_vintage_at: toWireInstant(edges.newestVintage),
      freshness: {
        data_through: toWireInstant(edges.newestTarget),
        source_checked_at: null,
        status: classifyForecastVintage(edges.newestVintage, context.now()),
        generated_at: toIsoSecond(context.now()),
      },
    },
    links: {
      self: buildLink(context.publicBaseUrl, path, {
        zone,
        type: forecastType,
        model: requestedModel,
      }),
      // A single vintage is never paged, so this is `null` rather than absent:
      // a client following `links.next` in a loop terminates on the field being
      // null, and an absent field is one `?.` away from an infinite loop.
      next: null,
    },
  };

  res.json(body);
}

/**
 * Resolve a model without a window, for `/latest`.
 *
 * `resolveServingModel` needs a window to ask "which model covers this period".
 * Here the question is simply "which model has ever written for this zone and
 * type", and the catalogue already knows: it is memoized coverage, so this costs
 * a lookup rather than a query.
 *
 * The catalogue is deliberately **not** filtered by the acknowledged-version
 * gate — it publishes which zones a model covers, which is a fact about the data
 * and not about what we are currently cleared to serve, and rebuilding it per
 * request to apply a filter would undo the memoization it exists for. What is
 * checked here is the one case where that could mislead: a triple whose entire
 * servable set is empty cannot answer, so it is skipped rather than resolved to
 * and then found silent. That state is a misconfigured ledger rather than a
 * normal one — `npm run modelversions -- status` names it — and skipping is what
 * keeps `/latest` resolving the same way `/forecasts` does.
 */
function firstModelWithRows(
  context: V1DataContext,
  zone: string,
  forecastType: string,
  gate: VersionGate
): string | null {
  const coverage = context.catalog.modelCoverage();
  for (const model of PUBLIC_FORECAST_MODELS) {
    const entry = coverage.find((c) => c.forecast_type === forecastType && c.model === model);
    if (!entry || !entry.zones.includes(zone)) continue;
    if (gate.servableVersions(zone, forecastType, model)?.length === 0) continue;
    return model;
  }
  return null;
}
