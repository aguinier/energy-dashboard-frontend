import { ABLE_FORECAST, ENTSOE_OBSERVATION, type SeriesSource } from './attribution.js';

/**
 * The registry: what every numeric field on this API *is*.
 *
 * ABL-293 §2a, "Units — every numeric field, explicitly". Today the unit lives
 * in the column name (`load_mw`, `price_eur_mwh`) and is then **stripped** on
 * the way out — `services/loadService.ts:19-20` returns `load`, and
 * `types/index.ts:25-29` types it as a bare number. Some internal endpoints put
 * a unit in `meta.unit`; most put it nowhere. A public contract cannot do that:
 * a number whose unit is folklore is a number a customer will eventually divide
 * by 1000.
 *
 * So the unit is declared here, once, beside the column it belongs to, and
 * every response carries it. The wire field name deliberately **drops** the
 * `_mw` suffix rather than keeping it: a unit in a field name is a unit that
 * silently becomes wrong the day a series changes unit, whereas a unit in a
 * declared field can only change by changing this table.
 *
 * The same entry carries the source and licence (ToS §7.3 — see
 * `attribution.ts`), so "what is this number, and whose is it" is one lookup
 * with one answer. Splitting them into two tables is how a series ends up with
 * a unit and no licence.
 */

/**
 * Which temporal family a series belongs to. This is not decoration: it selects
 * the freshness classifier, and applying the wrong one is the ABL-51 defect.
 *
 * - `measured` — strictly backward-looking. A measured hour cannot be published
 *   before it happens, so "how old is the newest row" is the whole question.
 * - `day_ahead` — a publication about tomorrow. A healthy day-ahead price is
 *   dated up to ~46h in the **future**, so age says nothing; the question is
 *   whether the newest row reaches the market day it should.
 * - `forecast` — our model output. A third clock again: judged by when the
 *   vintage was generated, not by where its targets land.
 *
 * `services/freshness.ts:193-211` makes the same split for the dashboard and
 * explains that applying the measured rule to a day-ahead series is "the mirror
 * of the bug this file exists for". `/v1` inherits the split rather than
 * flattening it.
 */
export type SeriesFamily = 'measured' | 'day_ahead' | 'forecast';

export interface SeriesDefinition {
  /** The key this appears under on a data row. Carries no unit, by design. */
  field: string;
  /** The column it is read from. A literal from this file, never a request value. */
  column: string;
  /** Stated on every response. `MW`, `EUR/MWh`. */
  unit: string;
  family: SeriesFamily;
  source: SeriesSource;
  /**
   * Whether a negative value is meaningful rather than an error.
   *
   * Published so a client can validate without guessing. Getting this wrong in
   * either direction is expensive: a client that rejects negative prices
   * discards real hours (negative prices are ordinary in this market), and a
   * client that expects negative load has been told to distrust a quantity that
   * is strictly positive.
   */
  signed: boolean;
}

/** The three observation streams. One table each, one ENTSO-E document each. */
export type ObservationStream = 'load' | 'price' | 'generation';

export const OBSERVATION_STREAMS: readonly ObservationStream[] = ['load', 'price', 'generation'];

export function isObservationStream(value: string): value is ObservationStream {
  return (OBSERVATION_STREAMS as readonly string[]).includes(value);
}

/**
 * The 21 production types `energy_generation` holds, in ENTSO-E A75 order.
 *
 * All 21 are emitted on every generation row, `null` where the zone does not
 * report that type — never omitted, never zero-filled. That is the NULL
 * contract (ABL-293 §2a, "Partial data"), and the numbers behind it: `nuclear_mw`
 * is reported by 14 of 34 zones and `marine_mw` by 2, against 33 for
 * `wind_onshore_mw`. `energy_generation` deliberately carries no `DEFAULT 0`,
 * unlike `energy_renewable`, so the distinction survives all the way from
 * ingest — and it would be this serializer that destroyed it.
 *
 * Every one is `signed: true`. ENTSO-E A75 reports consumption as negative
 * generation, which is routine for `hydro_pumped` (pumping) and appears on the
 * consumption-capable fossil types. Marking the whole table signed rather than
 * guessing which subset is honest about what we actually know: we have not
 * measured a per-type sign census, and a `signed: false` we cannot support is a
 * promise a client would enforce for us.
 */
const GENERATION_COLUMNS: readonly string[] = [
  'solar_mw',
  'wind_onshore_mw',
  'wind_offshore_mw',
  'hydro_run_mw',
  'hydro_reservoir_mw',
  'hydro_pumped_mw',
  'biomass_mw',
  'geothermal_mw',
  'marine_mw',
  'other_renewable_mw',
  'energy_storage_mw',
  'nuclear_mw',
  'fossil_gas_mw',
  'fossil_hard_coal_mw',
  'fossil_brown_coal_mw',
  'fossil_oil_mw',
  'fossil_oil_shale_mw',
  'fossil_peat_mw',
  'fossil_coal_derived_gas_mw',
  'waste_mw',
  'other_mw',
];

/** `solar_mw` -> `solar`. The one place the suffix is dropped. */
function fieldNameFor(column: string): string {
  return column.replace(/_mw$/, '');
}

const GENERATION_SERIES: readonly SeriesDefinition[] = GENERATION_COLUMNS.map((column) => ({
  field: fieldNameFor(column),
  column,
  unit: 'MW',
  family: 'measured' as const,
  source: ENTSOE_OBSERVATION,
  signed: true,
}));

/**
 * Load, in MW.
 *
 * `signed: false` is a claim this API also **enforces**: `services/loadQuality.ts`
 * filters `load_mw > 0`, because a national grid never draws exactly 0 MW and
 * 543 stored zeros across 11 zones are the ingest writing a placeholder where a
 * measurement should be. Those rows are absent from `/v1` rather than served as
 * a confident `0 MW` — the same reason the dashboard header stopped reading
 * `0 MW` for MK and SI.
 */
const LOAD_SERIES: SeriesDefinition = {
  field: 'load',
  column: 'load_mw',
  unit: 'MW',
  family: 'measured',
  source: ENTSOE_OBSERVATION,
  signed: false,
};

/**
 * Day-ahead price, in EUR/MWh.
 *
 * `signed: true`, and this is the one on the list most likely to be
 * mis-validated: **negative prices are real**, not errors, and a client that
 * filters them out has deleted exactly the hours it most wanted to see.
 */
const PRICE_SERIES: SeriesDefinition = {
  field: 'price',
  column: 'price_eur_mwh',
  unit: 'EUR/MWh',
  family: 'day_ahead',
  source: ENTSOE_OBSERVATION,
  signed: true,
};

/** Which table and series each observation stream reads. */
export interface StreamDefinition {
  stream: ObservationStream;
  table: string;
  series: readonly SeriesDefinition[];
  /**
   * `data_ingestion_log.pipeline_type` for this stream, or `null` when no pass
   * is attributable to it.
   *
   * `generation` maps to `renewable`, which reads like a mistake and is not:
   * `energy-data-gathering/src/fetch_renewable.py:126` calls
   * `log_ingestion_start('renewable', ...)` and writes the whole A75 document
   * into `energy_generation`. There is no `generation` pipeline_type in the log
   * — the vocabulary is `price`, `load`, `renewable`, `wind_solar_forecast`,
   * `load_forecast_day_ahead`, `load_forecast_week_ahead`, `weather_*`,
   * `net_position`, `crossborder_flows`. Mapping it to a plausible-looking
   * absent name would make `source_checked_at` permanently null; mapping it
   * here, with the citation, makes it true.
   */
  pipelineType: string | null;
}

export const STREAMS: Readonly<Record<ObservationStream, StreamDefinition>> = {
  load: { stream: 'load', table: 'energy_load', series: [LOAD_SERIES], pipelineType: 'load' },
  price: { stream: 'price', table: 'energy_price', series: [PRICE_SERIES], pipelineType: 'price' },
  generation: {
    stream: 'generation',
    table: 'energy_generation',
    series: GENERATION_SERIES,
    pipelineType: 'renewable',
  },
};

/** Every production type name a caller may pass to `?production_type=`. */
export const PRODUCTION_TYPES: readonly string[] = GENERATION_SERIES.map((s) => s.field);

/**
 * Our forecast values, in the unit of whatever they forecast.
 *
 * The unit is **per forecast type**, not per row, which is why this is a
 * function rather than a constant: a `price` forecast is EUR/MWh and a `load`
 * forecast is MW, and a single `forecast_value` field with a fixed unit would
 * be wrong for one of them. The type is echoed on every response beside the
 * unit so the pairing is never inferred.
 */
export function forecastSeries(forecastType: string): SeriesDefinition {
  const isPrice = forecastType === 'price';
  return {
    field: 'value',
    column: 'forecast_value',
    unit: isPrice ? 'EUR/MWh' : 'MW',
    family: 'forecast',
    source: ABLE_FORECAST,
    // A price forecast can go negative because prices do. A load or generation
    // forecast should not, but the model is not constrained to positive output
    // and ABL-335 found solar forecasts fitting negative at four zones — so
    // saying "unsigned" here would be asserting a property of a model rather
    // than of the data we actually return.
    signed: true,
  };
}
