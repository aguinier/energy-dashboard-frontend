import { Router, type Request, type Response } from 'express';
import { describeSeries, type Coverage, type Envelope } from '../data/envelope.js';
import { freshnessBlockOf, toWireInstant } from '../data/freshnessMap.js';
import { buildLink } from '../data/links.js';
import { parseEnum, parseHorizon, parseWindow, parseZone, toIsoSecond } from '../data/params.js';
import {
  ACCURACY_TYPE_IDS,
  accuracyStream,
  countForecastHours,
  readAccuracyPoints,
  readNewestVintage,
} from '../data/accuracyRepo.js';
import { calculateAccuracy, NO_METRICS, type AccuracyMetrics } from '../data/accuracyMetrics.js';
import { resolveServingModel } from '../data/forecastsRepo.js';
import { PUBLIC_FORECAST_MODELS } from '../data/models.js';
import { ABLE_FORECAST } from '../data/attribution.js';
import { OPEN_VERSION_GATE } from '../modelVersions/versionGuard.js';
import type { SeriesDefinition } from '../data/series.js';
import type { V1DataContext } from '../data/context.js';

/**
 * `GET /v1/accuracy` — how our forecasts actually performed.
 *
 * ```
 * GET /v1/accuracy ?zone=&type=&from=&to=&horizon=&model=
 * ```
 *
 * The ninth of ABL-293 §2a's non-net-position endpoints, and the only one that
 * *joins*. ABL-303 shipped the other eight and filed this separately because the
 * join is a live correctness hazard rather than routine work; `data/accuracyRepo.ts`
 * carries that argument in full and is the file to read before changing the SQL.
 * What follows is what the endpoint promises.
 *
 * ## `coverage` is required, and it is the whole point
 *
 * Every accuracy response carries `meta.coverage`, and on this endpoint it is
 * load-bearing in a way it is not anywhere else on `/v1`. An accuracy endpoint
 * has to reduce a window to a number, and the number `0` means "flawless". A
 * window we could not measure — because that model does not serve the zone,
 * because the window is in the future, because the actuals summed to zero —
 * must not be reported as a flawless forecast. So:
 *
 * - every metric is `null`, never `0`, whenever it is not measurable, and
 * - `coverage` says which kind of not-measurable it was, and
 * - `data` still carries one row with all five fields present, so a client
 *   reading `data[0].mape` finds `null` rather than an absent key. `[]` would
 *   have been the tidier shape and is the wrong one: `data[0]?.mape ?? 0` is
 *   what a client writes against an array that is sometimes empty, and that
 *   expression is the defect.
 *
 * ## What a number here is a statement about
 *
 * Four things, and all four are echoed on the response rather than assumed:
 * `zone`, `forecast_type`, `model` and `horizon_hours`. Accuracy without the
 * model is not a fact — the two served models cover disjoint zone sets, so
 * "our load forecast for France" and "catboost's load forecast for France" are
 * different claims and only one of them is measurable. `latest_vintage_at`
 * carries the fifth: how recently the model that produced these numbers ran.
 *
 * ## The conflicting-timestamp convention is published, not silently applied
 *
 * `meta.conflict_convention` is `space_preferred` on every response. Where this
 * database holds the same country-hour under both stored separator forms with
 * *different* values, the space-form row is the one scored. Which of that pair
 * is authoritative is **ABL-215, an open Board question**, and this endpoint
 * does not answer it — it declares which one it serves so that a later ruling is
 * a documented change to a stated convention rather than a silent correction to
 * numbers a subscriber has already used. See `data/accuracyRepo.ts`.
 *
 * ## ToS §7.3: these numbers are ours
 *
 * An accuracy metric is Forecast Output (§2), so the per-series block is
 * `source: able` with `attribution_required: false` — even though the *actual*
 * on one side of the join is ENTSO-E's. That is not an oversight: what is served
 * here is the reduction, which is our computation over our model's output, and
 * the observation it was computed against is separately available under its own
 * CC-BY series block at `/v1/observations`. A subscriber who republishes an
 * ENTSO-E observation attributes it; one who republishes our MAPE does not.
 *
 * ## Not here
 *
 * - **Net position.** Absent by construction across `/v1` — no series, no
 *   catalogue entry, no route. ABL-298 closing (JAO authorisation held) is not a
 *   reason to add it; Board decision 2 is open, and ENTSO-E is resellable where
 *   JAO is not.
 * - **`GET /tso-forecast/accuracy/generation/:cc`.** ABL-293 §3: the TSO
 *   forecasts are the TSOs' own, free from ENTSO-E, and are context rather than
 *   product. We sell our accuracy *against* them; we do not sell them.
 * - **`hydro_total` and `renewable`.** Served by `/v1/forecasts`, refused here,
 *   because what their actual *is* on `energy_generation` is ABL-399 and is not
 *   this endpoint's decision to take by picking a column. See
 *   `data/accuracyRepo.ts`.
 */

export function accuracyRouter(context: V1DataContext): Router {
  const router = Router();
  router.get('/', (req, res) => serveAccuracy(context, req, res));
  return router;
}

/**
 * The `series` block for an accuracy response: one entry per metric field.
 *
 * Five fields and **two different units** in one response, which is exactly the
 * case §8.1 says a response-level unit would get wrong. `mape`/`wape`/`smape`
 * are percentages; `mae`/`rmse` are in the unit of whatever was forecast — MW
 * for load and generation, EUR/MWh for price. A subscriber charting MAE across
 * types without reading this block is charting megawatts against euros.
 *
 * All five are `signed: false`. Every one is built from an absolute value or a
 * square, so a negative is not merely unexpected here but arithmetically
 * unreachable — unlike `bias`, which is signed and is deliberately not on this
 * contract (ABL-293 §2a names five measures; adding a sixth to a public
 * response is a commitment, not a convenience).
 */
function accuracySeries(unit: string): SeriesDefinition[] {
  const percent = ['mape', 'wape', 'smape'].map((field) => ({
    field,
    column: field,
    unit: '%',
    family: 'forecast' as const,
    source: ABLE_FORECAST,
    signed: false,
  }));
  const targetUnit = ['mae', 'rmse'].map((field) => ({
    field,
    column: field,
    unit,
    family: 'forecast' as const,
    source: ABLE_FORECAST,
    signed: false,
  }));
  return [...percent, ...targetUnit];
}

/**
 * Which of the three empty answers this is.
 *
 * Only asked when nothing paired — a sample is `ok` by definition. The order
 * matters: `no_model_coverage` is checked against forecast rows rather than
 * against pairs, because "catboost does not serve France" and "catboost
 * forecast this window and the actuals have not landed" are different facts
 * with different remedies, and a caller acts on them differently.
 */
function accuracyCoverage(sampleSize: number, forecastHours: number): Coverage {
  if (sampleSize > 0) return 'ok';
  return forecastHours > 0 ? 'no_paired_actuals' : 'no_model_coverage';
}

interface AccuracyMetaExtras {
  forecast_type: string;
  model: string | null;
  horizon_hours: number | null;
  /**
   * Distinct target hours the model forecast in this window.
   *
   * The denominator `sample_size` is the numerator of. Published because the two
   * are routinely far apart and the gap is information rather than an error: a
   * window running into the future forecasts hours no actual can pair with yet,
   * and `load` drops hours whose stored actual is an impossible `0.0`. A
   * subscriber who sees `forecast_hours: 744, sample_size: 500` knows the figure
   * covers two thirds of the window; without it, a metric computed over a third
   * of a month is indistinguishable from one computed over all of it.
   */
  forecast_hours: number;
  latest_vintage_at: string | null;
  /** How a conflicting stored-timestamp pair is resolved. See the module note. */
  conflict_convention: 'space_preferred';
}

function serveAccuracy(context: V1DataContext, req: Request, res: Response): void {
  const zone = parseZone(req.query.zone);
  const forecastType = parseEnum(req.query.type, 'type', ACCURACY_TYPE_IDS, {
    required: true,
  }) as string;
  const window = parseWindow(req.query as Record<string, unknown>);
  const horizonHours = parseHorizon(req.query.horizon);
  const requestedModel = parseEnum(req.query.model, 'model', PUBLIC_FORECAST_MODELS, {
    required: false,
  });

  // Same resolution rule as `/v1/forecasts`, and it must stay the same one: an
  // explicit model is honoured strictly, an absent one resolves to the first
  // served model with rows for this zone, type and window. Reporting xgboost's
  // accuracy under catboost's name is the plausible-wrong-number-under-the-
  // wrong-label failure, and on this endpoint the label *is* the product.
  //
  // **Deliberately ungated** (ABL-529), and this is a scope decision rather than
  // an omission, so it is stated where someone would look for it.
  //
  // The acknowledged-version guard restricts which artifact may serve *forecast
  // values*. This endpoint scores **history**, and history is made of superseded
  // artifacts by design — the ledger records what may be served now, not every
  // version that ever ran, so filtering accuracy through it would silently drop
  // every pre-swap sample and make a 90-day figure that straddles a promotion
  // read as if the model only existed for the days since. Worse, the historical
  // number would then *move when a ledger entry was added*, for a reason that
  // has nothing to do with the data.
  //
  // The residual, named rather than left to be found: for a window reaching the
  // present, an accuracy figure will reflect a newly promoted artifact while
  // `/v1/forecasts` is still withholding it — so a subscriber can measure the
  // accuracy of numbers they have not been served. That is bounded (it needs a
  // window overlapping the swap forward), it is not the §9.3.1 failure this
  // issue closes (§9.3.1 is about *forecast values under the same label*, and
  // §10.2 already says derived figures follow revisions), and closing it needs
  // the ledger to record every historical version rather than the servable ones.
  // Filed as follow-up; do not bolt it on here by reusing the serving gate.
  const model =
    requestedModel ??
    resolveServingModel(context.source, zone, forecastType, window, OPEN_VERSION_GATE) ??
    null;

  const query = model === null ? null : { zone, forecastType, model, window, horizonHours };

  const points = query === null ? [] : readAccuracyPoints(context.source, query);
  const metrics: AccuracyMetrics = points.length === 0 ? NO_METRICS : calculateAccuracy(points);
  // Asked on every request, not only on an empty one. It decides `coverage` when
  // nothing paired, and it is `sample_size`'s denominator when something did —
  // and a denominator that is only computed when the numerator is zero is not a
  // denominator. It is a single indexed COUNT over the window the main query has
  // already bounded.
  const forecastHours = query === null ? 0 : countForecastHours(context.source, query);
  const newestVintage =
    model === null ? null : readNewestVintage(context.source, zone, forecastType, model);

  const unit = forecastType === 'price' ? 'EUR/MWh' : 'MW';
  const path = '/v1/accuracy';
  const linkParams = {
    zone,
    type: forecastType,
    from: window.fromIso,
    to: window.toIso,
    horizon: horizonHours,
    model: requestedModel,
  };

  const body: Envelope<AccuracyMetrics> & { meta: AccuracyMetaExtras } = {
    // Always exactly one row, even when nothing was measurable — see the module
    // note on why an empty array would be the wrong shape here.
    data: [metrics],
    meta: {
      resource: 'accuracy',
      zone,
      forecast_type: forecastType,
      model,
      horizon_hours: horizonHours ?? null,
      from: window.fromIso,
      to: window.toIso,
      coverage: accuracyCoverage(metrics.sample_size, forecastHours),
      forecast_hours: forecastHours,
      row_count: 1,
      row_limit: 1,
      truncated: false,
      // An aggregate has no observed spacing. `null` rather than the window's
      // nominal resolution: reporting one would describe the rows that went in,
      // which are not the row that comes out.
      resolution: null,
      resolution_uniform: null,
      series: describeSeries(accuracySeries(unit)),
      latest_vintage_at: toWireInstant(newestVintage),
      conflict_convention: 'space_preferred' as const,
      freshness: {
        // The **actuals** stream, not the forecast one. Accuracy cannot be
        // measured past the newest actual we hold, so that edge is the one that
        // bounds this endpoint's answer — a forecast-side `data_through` reaching
        // 64 hours into the future would advertise measurability we do not have.
        // `latest_vintage_at` above carries the forecast side.
        ...freshnessBlockOf(context.freshness.lookup(zone, accuracyStream(forecastType))),
        generated_at: toIsoSecond(context.now()),
      },
    },
    links: {
      self: buildLink(context.publicBaseUrl, path, linkParams),
      // One aggregate is never paged. `null` rather than absent, for the reason
      // `/v1/forecasts/latest` gives: a client following `links.next` in a loop
      // terminates on the field being null, and an absent field is one `?.` away
      // from an infinite loop.
      next: null,
    },
  };

  res.json(body);
}
