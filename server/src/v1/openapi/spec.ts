import { ENTSOE_OBSERVATION, ABLE_FORECAST, type LicenceId } from '../data/attribution.js';
import type { Coverage } from '../data/envelope.js';
import { MAX_GAPS } from '../data/catalogRepo.js';
import { ACCURACY_TYPE_IDS } from '../data/accuracyRepo.js';
import {
  MAX_HORIZON_HOURS,
  PUBLIC_FORECAST_MODELS,
  PUBLIC_FORECAST_TYPES,
  PUBLIC_FORECAST_TYPE_IDS,
  type ForecastStability,
} from '../data/models.js';
import { MAX_ROW_LIMIT, MAX_WINDOW_DAYS } from '../data/params.js';
import { OBSERVATION_STREAMS, PRODUCTION_TYPES } from '../data/series.js';
import { AUTH_ERROR_CODES } from '../auth/apiKeyAuth.js';
import { THROTTLE_ERROR_CODES } from '../quota/planGate.js';
import type { FreshnessStatus } from '../../types/index.js';

/**
 * The published OpenAPI document for `/v1` — built from the implementation's
 * own constants, not typed out beside them.
 *
 * ABL-305. A drifted spec is worse than no spec: it is a contract a subscriber
 * writes a client against and we do not keep. Two mechanisms keep this one
 * honest, and they catch different things:
 *
 * 1. **This file imports what it documents.** The zone-code grammar, the 21
 *    production types, the eight forecast types, the two models, the row cap,
 *    the 366-day window bound, the 64-hour horizon ceiling, the auth error
 *    codes and both `SeriesSource` constants are *read from the modules that
 *    implement them*. There is no second copy to fall out of date, so a change
 *    to `models.ts` changes the document in the same commit or fails the check
 *    below.
 * 2. **`drift.test.ts` validates real responses against these schemas**, in both
 *    directions: a promised field that stopped arriving fails on `required`, and
 *    an arriving field nobody documented fails on `additionalProperties: false`.
 *
 * What the pair cannot catch is stated in `drift.test.ts` rather than implied.
 *
 * ## ToS §7.3 is the reason a field here is `required` rather than described
 *
 * ABL-297, Board-approved 2026-08-12, promises subscribers that *every* data
 * series carries a source and licence field so CC-BY 4.0 attribution for
 * ENTSO-E-derived data can be rendered programmatically. A field that exists in
 * a response but not in the published contract is a field integrators will not
 * know to read — which leaves them in breach of an attribution obligation we
 * passed to them, and us in breach of §7.2, which we cannot waive because the
 * duty flows from CC-BY 4.0 upstream.
 *
 * So {@link SERIES_SOURCE_SCHEMA} is `required` at every level it appears —
 * inside every series descriptor, on every catalogue entry — with all five of
 * its own fields required and `additionalProperties: false`. `drift.test.ts`
 * has a block that asserts exactly that on the document *and* proves the check
 * is load-bearing by deleting the field from a real response and watching
 * validation fail.
 *
 * ## Clause numbers belong in these comments and never in a `description`
 *
 * ABL-522 Constraint 2. Comments in this file are read by whoever maintains it
 * and are welcome to cite the clause that governs a decision — that is the
 * whole reason the section above names §7.3. A `description` string is a
 * different audience: it ships in `docs/api/v1/openapi.json` and is rendered to
 * whoever eventually reads the published contract, who does not hold the Terms
 * and — while ABL-349 is open — cannot obtain them. A citation there tells that
 * reader an obligation is imposed on them by §7.1 and gives them no way to read
 * §7.1, which is the same failure {@link GATED_INFO_FIELDS} exists to prevent,
 * arriving through prose instead of through a field.
 *
 * So every obligation the document places on an integrator is **stated here in
 * full, in the document's own words**, and a clause number is never the thing
 * carrying the meaning. This is not silence about the contract: the rule is
 * enforced alongside a test asserting the attribution obligation is still
 * legible without it, because a rule that can be satisfied by deleting the
 * explanation is worse than the citation was.
 *
 * `drift.test.ts` enforces both halves against the built document.
 *
 * ## Three `info` fields are deliberately absent (ABL-349)
 *
 * `info.termsOfService`, `info.license` and `info.contact` are **not set**, and
 * this is the one way this document could breach the ABL-349 gate by default
 * rather than by neglect — a spec template or a generator fills them in as a
 * matter of course. Filling `termsOfService` publishes the ToS by reference;
 * `license` asserts licence terms to every consumer of the document; `contact`
 * publishes an address, and ABL-349 item 1 is the open finding that our
 * published contact addresses do not reach a human. Until the Board lifts the
 * deferral on public exposure they stay unset, and `drift.test.ts` fails if any
 * of them appears — including via a URL pointing at the ABL-297 drafts.
 *
 * Note what the gate does *not* forbid: generating this document, committing it
 * and checking it against the code. The gate is about exposure, not about the
 * artifact existing. Nothing serves it over HTTP — there is no route for it in
 * `publicApp.ts`, deliberately.
 *
 * ## Versioning
 *
 * `info.version` is the version of *this document*, not of the API. The API's
 * version is `v1` and lives in the path. They are separate on purpose: the
 * document gets corrections that are not API changes.
 */

export const OPENAPI_VERSION = '3.1.0';

/**
 * The document's own version.
 *
 * Bumped when the described contract changes. `1.0.0` is the first publication,
 * describing the surface as ABL-303 and ABL-373 shipped it.
 */
export const DOCUMENT_VERSION = '1.0.0';

/**
 * The three `info` fields the ABL-349 gate forbids while it is open.
 *
 * Named here as data rather than left as an absence, so the test that enforces
 * it and the document that must not carry it read from one list.
 */
export const GATED_INFO_FIELDS = ['termsOfService', 'license', 'contact'] as const;

/**
 * Compile-time exhaustiveness: `Exclude<Union, listed>` must be `never`.
 *
 * This is the half of the drift check that runs in `tsc` rather than in vitest.
 * Adding a value to `Coverage` or `FreshnessStatus` without adding it to the
 * matching list below is a **build** failure, which is the right place for it:
 * the enum in a published document silently missing a value the server can
 * actually send is a client's `switch` falling through to `default`.
 */
type Exhaustive<Union extends string, Listed extends readonly string[]> = Exclude<
  Union,
  Listed[number]
> extends never
  ? true
  : never;

/**
 * Every `coverage` value the envelope defines, across all endpoints.
 *
 * The per-endpoint schemas below each declare the **subset that endpoint can
 * actually return**, which is narrower and therefore more useful than this
 * union — an accuracy response can never say `upstream_gap`, and documenting
 * that it might would send a client looking for a branch it will never take.
 * This list exists for the exhaustiveness check and for the shared description.
 *
 * `not_captured` is reserved and produced by no endpoint in this release, so it
 * appears in no per-endpoint enum.
 */
const ALL_COVERAGE = [
  'ok',
  'no_data',
  'out_of_scope',
  'upstream_gap',
  'not_captured',
  'no_model_coverage',
  'no_paired_actuals',
] as const;
const _coverageIsExhaustive: Exhaustive<Coverage, typeof ALL_COVERAGE> = true;

const OBSERVATION_COVERAGE = ['ok', 'no_data', 'out_of_scope', 'upstream_gap'] as const;
const FORECAST_COVERAGE = ['ok', 'no_data', 'out_of_scope'] as const;
const ACCURACY_COVERAGE = ['ok', 'no_model_coverage', 'no_paired_actuals'] as const;

const FRESHNESS_STATUSES = ['live', 'stale', 'ended', 'none'] as const;
const _freshnessIsExhaustive: Exhaustive<FreshnessStatus, typeof FRESHNESS_STATUSES> = true;

const STABILITIES = ['stable', 'beta'] as const;
const _stabilityIsExhaustive: Exhaustive<ForecastStability, typeof STABILITIES> = true;

const LICENCES = ['CC-BY-4.0', 'proprietary'] as const;
const _licenceIsExhaustive: Exhaustive<LicenceId, typeof LICENCES> = true;

/**
 * The units any numeric field on this surface carries.
 *
 * `%` is the accuracy endpoint's, and it is the reason this is an enum rather
 * than a free string: one accuracy response mixes percentages with MW or
 * EUR/MWh, which is the case ToS §8.1 exists for. A unit appearing that is not
 * on this list is a contract change, and the drift check should refuse it.
 */
const UNITS = ['MW', 'EUR/MWh', '%'] as const;

type Schema = Record<string, unknown>;

const TIMESTAMP_PATTERN_NOTE =
  'RFC 3339 UTC with an explicit Z, at second precision — 2026-08-12T14:00:00Z. ' +
  'Never a local time, never an offset.';

function timestamp(description: string): Schema {
  return { type: 'string', description: `${description} ${TIMESTAMP_PATTERN_NOTE}` };
}

function nullableTimestamp(description: string): Schema {
  return { type: ['string', 'null'], description: `${description} ${TIMESTAMP_PATTERN_NOTE}` };
}

// ---------------------------------------------------------------------------
// ToS §7.3 — the per-series source and attribution field
// ---------------------------------------------------------------------------

/**
 * The contractual field. Every property required; no property undeclared.
 *
 * The two constants that populate it — {@link ENTSOE_OBSERVATION} and
 * {@link ABLE_FORECAST} — are imported and rendered into the examples below, so
 * the document cannot describe an attribution line different from the one the
 * server sends.
 */
const SERIES_SOURCE_SCHEMA: Schema = {
  type: 'object',
  title: 'SeriesSource',
  description:
    'Where this series came from and under what licence you may redistribute it. ' +
    'Required on every series and every catalogue entry, so that attribution can be ' +
    'rendered programmatically rather than remembered; carried per series rather than ' +
    'per response because one response can mix provenance, and a generation response ' +
    'carries 21 series at once.',
  properties: {
    id: {
      type: 'string',
      enum: [ENTSOE_OBSERVATION.id, ABLE_FORECAST.id],
      description:
        'Stable machine handle for the origin. Branch on this, not on `name`: ' +
        '`entsoe` is data ingested from the ENTSO-E Transparency Platform, ' +
        '`able` is our own model output.',
    },
    name: {
      type: 'string',
      enum: [ENTSOE_OBSERVATION.name, ABLE_FORECAST.name],
      description: 'Display name of the origin. For rendering, not for branching.',
    },
    licence: {
      type: 'string',
      enum: [...LICENCES],
      description:
        '`CC-BY-4.0` for ENTSO-E-derived observations; `proprietary` for our forecast ' +
        'output, which is licensed to you by your subscription rather than by a public deed.',
    },
    licence_url: {
      type: ['string', 'null'],
      description:
        'The public licence deed, or `null` where the licence is your subscription rather ' +
        'than a public one. Deliberately not a link to our Terms: a use licence granted ' +
        'under contract is not the same kind of thing as a public deed a downstream ' +
        'recipient can rely on.',
    },
    attribution_required: {
      type: 'boolean',
      description:
        'Whether you must attribute when you republish this series. **This is the field to ' +
        'branch on.** It is deliberately not derivable from `licence` without hardcoding a ' +
        'licence table, which is exactly the remembering this field exists to remove. It is ' +
        'present and `false` on our own series too, so that "no attribution needed" and ' +
        '"we forgot the field" are not the same shape.',
    },
    attribution: {
      type: ['string', 'null'],
      description:
        'The exact line to render, or `null` when none is required. Rendering this string ' +
        'verbatim discharges the obligation: the wording you are asked to render and the ' +
        'wording we hand you here are one and the same string, so the two cannot drift.',
    },
  },
  required: ['id', 'name', 'licence', 'licence_url', 'attribution_required', 'attribution'],
  additionalProperties: false,
  examples: [ENTSOE_OBSERVATION, ABLE_FORECAST],
};

const SERIES_DESCRIPTOR_SCHEMA: Schema = {
  type: 'object',
  title: 'SeriesDescriptor',
  description:
    'One entry per numeric field on a data row: what the number is, what unit it is in, ' +
    'whether negatives are meaningful, and whose data it is.',
  properties: {
    field: {
      type: 'string',
      description:
        'The key this series appears under on a data row. Carries no unit suffix by design ' +
        '— a unit in a field name is a unit that silently becomes wrong the day the series ' +
        'changes unit.',
    },
    unit: { type: 'string', enum: [...UNITS], description: 'The unit of every value in this series.' },
    signed: {
      type: 'boolean',
      description:
        'Whether a negative value is meaningful rather than an error. Published so a client ' +
        'can validate without guessing: negative day-ahead prices are ordinary and a client ' +
        'that filters them has deleted the hours it most wanted, while load is strictly ' +
        'positive and a negative would be a defect.',
    },
    source: { $ref: '#/components/schemas/SeriesSource' },
  },
  required: ['field', 'unit', 'signed', 'source'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Shared envelope pieces
// ---------------------------------------------------------------------------

const FRESHNESS_SCHEMA: Schema = {
  type: 'object',
  title: 'Freshness',
  description:
    'How current this series is, on every response. Three different clocks are kept apart ' +
    'deliberately: when we last hold data for, when we last went and looked upstream, and ' +
    'when this payload was computed.',
  properties: {
    data_through: nullableTimestamp(
      'The newest row we hold for this series. **Legitimately in the future** for a ' +
        'day-ahead price or a forecast, which is why age alone is not a freshness verdict.'
    ),
    source_checked_at: nullableTimestamp(
      'When we last attempted an upstream pass for this series. An attempt, not a success ' +
        'claim. `null` for our own forecast output, which has no upstream to have checked.'
    ),
    status: {
      type: 'string',
      enum: [...FRESHNESS_STATUSES],
      description:
        '`live` — current. `stale` — behind where it should be. `ended` — the series has ' +
        'received no newer row across many passes; the upstream publisher appears to have ' +
        'stopped. `none` — we hold nothing for this zone and stream. The rule that decides ' +
        'this differs by series family: a measured series is judged on age, a day-ahead ' +
        'series on whether it reaches the market day it should.',
    },
    generated_at: timestamp('When this response body was computed.'),
  },
  required: ['data_through', 'source_checked_at', 'status', 'generated_at'],
  additionalProperties: false,
};

const EXCLUDED_NOTE_SCHEMA: Schema = {
  type: 'object',
  title: 'ExcludedNote',
  description:
    'A class of row this API deliberately does not serve, named on the response that would ' +
    'otherwise have contained it. Reconciling our counts against ENTSO-E’s should not ' +
    'require a support thread.',
  properties: {
    reason: { type: 'string', description: 'Stable machine handle for the exclusion.' },
    detail: { type: 'string', description: 'What was excluded and why, in prose.' },
  },
  required: ['reason', 'detail'],
  additionalProperties: false,
};

function linksSchema(pageable: boolean): Schema {
  return {
    type: 'object',
    title: pageable ? 'PagedLinks' : 'Links',
    properties: {
      self: {
        type: 'string',
        description:
          'This request, canonicalised. Relative unless an absolute public base URL is ' +
          'configured — never built from the Host header, so a link we hand you cannot ' +
          'bake our current address into your stored URLs.',
      },
      next: pageable
        ? {
            type: ['string', 'null'],
            description:
              'The next page, or `null` when this is the last one. Emitted only when a next ' +
              'page exists: following a `next` that leads to an empty page would bill you ' +
              'for discovering there was nothing there.',
          }
        : {
            type: 'null',
            description:
              'Always `null` — this resource is never paged. `null` rather than absent, so a ' +
              'client looping on `links.next` terminates instead of running forever on an ' +
              'optional-chained `undefined`.',
          },
    },
    required: ['self', 'next'],
    additionalProperties: false,
  };
}

// ---------------------------------------------------------------------------
// Data rows
// ---------------------------------------------------------------------------

const ROW_TIMESTAMP = timestamp(
  'The **start** of the interval this row describes; the window is half-open, so a row ' +
    'labelled 14:00 covers 14:00 up to but not including the next interval.'
);

function singleSeriesRow(title: string, field: string, unit: string, note: string): Schema {
  return {
    type: 'object',
    title,
    properties: {
      timestamp: ROW_TIMESTAMP,
      [field]: { type: 'number', description: `${note} In ${unit}.` },
    },
    required: ['timestamp', field],
    additionalProperties: false,
  };
}

/**
 * A generation row: the timestamp and all 21 ENTSO-E A75 production types.
 *
 * The property list is `PRODUCTION_TYPES` itself, so a type added to the
 * registry appears here in the same commit.
 *
 * `required` is `timestamp` alone even though an unfiltered response carries all
 * 22 keys, because `?production_type=` narrows the emitted set and a schema that
 * required all of them would be wrong for a filtered request. The stronger claim
 * — *an unfiltered generation response carries exactly these 21 types* — is
 * asserted directly in `drift.test.ts`, where it can be stated without lying
 * about the filtered case.
 */
const GENERATION_ROW_SCHEMA: Schema = {
  type: 'object',
  title: 'GenerationRow',
  description:
    'One hour (or quarter-hour) of generation by production type, in MW. Every requested ' +
    'type is present as a key on every row: `null` means the zone does not report that ' +
    'type, and `0` means it reported zero. Those are different facts and this API never ' +
    'collapses them — nuclear is reported by 14 of 34 zones and marine by 2, while solar ' +
    'at 03:00 is a measured zero. Nothing is interpolated, forward-filled or carried across ' +
    'a gap.',
  properties: {
    timestamp: ROW_TIMESTAMP,
    ...Object.fromEntries(
      PRODUCTION_TYPES.map((field) => [
        field,
        {
          type: ['number', 'null'],
          description: `${field.replace(/_/g, ' ')} generation in MW, or null where this zone does not report it.`,
        },
      ])
    ),
  },
  required: ['timestamp'],
  additionalProperties: false,
};

const FORECAST_ROW_SCHEMA: Schema = {
  type: 'object',
  title: 'ForecastRow',
  description:
    'One forecast value for one target interval, from the newest run that covers it.',
  properties: {
    timestamp: ROW_TIMESTAMP,
    value: {
      type: 'number',
      description:
        'The forecast value, in the unit `meta.series[0].unit` states — MW for every type ' +
        'except `price`, which is EUR/MWh.',
    },
    generated_at: nullableTimestamp(
      'When the run that produced this value was generated. On every row rather than behind ' +
        'an opt-in: at 03:00 UTC the newest vintage is eight hours old because our runs stop ' +
        'at 19:00 and resume at 07:00, and the forecast is not stale — the silence about its ' +
        'age would have been.'
    ),
    horizon_hours: {
      type: 'integer',
      description: `Hours between the run and the target interval. 2 to ${MAX_HORIZON_HOURS} observed; there is no D+3.`,
    },
    model: {
      type: 'string',
      enum: [...PUBLIC_FORECAST_MODELS],
      description:
        'Which model produced this value. Echoed per row as well as in `meta`, so a fallback ' +
        'to the model that actually covers your zone is visible in the data.',
    },
  },
  required: ['timestamp', 'value', 'generated_at', 'horizon_hours', 'model'],
  additionalProperties: false,
};

const ACCURACY_ROW_SCHEMA: Schema = {
  type: 'object',
  title: 'AccuracyRow',
  description:
    'Forecast-versus-actual metrics over the requested window. **Every metric is `null` ' +
    'rather than `0` when it is not measurable**, and `meta.coverage` says which kind of ' +
    'not-measurable it was: `0` means a flawless forecast, and an unmeasurable window must ' +
    'never be reported as one. Exactly one of these rows is returned on every response, ' +
    'including an unmeasurable one — an empty array would invite `data[0]?.mape ?? 0`, ' +
    'which is the defect.',
  properties: {
    mape: {
      type: ['number', 'null'],
      description:
        'Mean absolute percentage error, 0-100. `null` when no paired point had a positive ' +
        'actual — the denominator would have been zero.',
    },
    wape: {
      type: ['number', 'null'],
      description: 'Weighted absolute percentage error, 0-100. `null` when the actuals sum to zero.',
    },
    smape: {
      type: ['number', 'null'],
      description:
        'Symmetric MAPE, 0-100, defined as `100 * mean(|a - f| / (|a| + |f|))`. Note there ' +
        'are two definitions of sMAPE in circulation and they differ by a factor of two; ' +
        'this is the one bounded on 0-100. `null` when no point had a non-zero magnitude.',
    },
    mae: {
      type: ['number', 'null'],
      description:
        'Mean absolute error, **in the unit of the target** — MW, or EUR/MWh for price. ' +
        'Charting this across forecast types without reading `meta.series` charts megawatts ' +
        'against euros. `null` when nothing paired.',
    },
    rmse: {
      type: ['number', 'null'],
      description: 'Root mean square error, in the unit of the target. `null` when nothing paired.',
    },
    sample_size: {
      type: 'integer',
      description: 'Paired forecast hours. The sample behind `mae`, `rmse` and `wape`.',
    },
    mape_samples: {
      type: 'integer',
      description: 'Of those, the ones with a positive actual — the sample behind `mape`.',
    },
    smape_samples: {
      type: 'integer',
      description: 'Of those, the ones with a non-zero magnitude — the sample behind `smape`.',
    },
  },
  required: [
    'mape',
    'wape',
    'smape',
    'mae',
    'rmse',
    'sample_size',
    'mape_samples',
    'smape_samples',
  ],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Response envelopes
// ---------------------------------------------------------------------------

const ZONE_META: Schema = {
  type: 'string',
  description: 'The bidding-zone code this response is about, echoed from the request.',
};

const ROW_COUNT_META: Schema = { type: 'integer', description: 'Rows in `data`.' };

const ROW_LIMIT_META: Schema = {
  type: 'integer',
  description: `The row cap that was applied. Stated on every response even when it did not bite. All plans share the same cap of ${MAX_ROW_LIMIT}.`,
};

const TRUNCATED_META: Schema = {
  type: 'boolean',
  description:
    'Whether the cap bit. A fact, not `row_count === row_limit` — a window holding exactly ' +
    'the cap many rows is not truncated, and treating it as such hands you a `next` link to ' +
    'an empty page forever.',
};

const RESOLUTION_META: Schema = {
  type: ['string', 'null'],
  description:
    'The **observed** modal spacing of the rows returned, as an ISO 8601 duration (`PT15M`, ' +
    '`PT1H`). Reported, not promised: this API does not aggregate and accepts no resolution ' +
    'parameter. `null` on a page of fewer than two rows, where there is no spacing to observe.',
};

const RESOLUTION_UNIFORM_META: Schema = {
  type: ['boolean', 'null'],
  description:
    'Whether every gap in the returned rows equals `resolution`. `false` means there are ' +
    'holes — this API never interpolates across one. `null` where `resolution` is.',
};

function seriesMeta(description: string): Schema {
  return {
    type: 'array',
    description,
    items: { $ref: '#/components/schemas/SeriesDescriptor' },
    minItems: 1,
  };
}

const SERIES_META_DESCRIPTION =
  'One entry per numeric field on a data row, carrying its unit and its source and ' +
  'licence. Required on every response that carries data.';

function observationsResponse(stream: string, rowRef: string, seriesNote: string): Schema {
  return {
    type: 'object',
    title: `Observations${stream[0].toUpperCase()}${stream.slice(1)}Response`,
    properties: {
      data: { type: 'array', items: { $ref: rowRef } },
      meta: {
        type: 'object',
        properties: {
          resource: { type: 'string', const: `observations.${stream}` },
          zone: ZONE_META,
          from: timestamp('Start of the served window, inclusive.'),
          to: timestamp('End of the served window, **exclusive**.'),
          coverage: {
            type: 'string',
            enum: [...OBSERVATION_COVERAGE],
            description:
              'Why `data` looks the way it does — and, when it is empty, **whose** absence ' +
              'this is. `ok` — rows were returned. `upstream_gap` — we hold this zone and ' +
              'stream and the window falls inside the period we hold, and upstream did not ' +
              'publish it; this is not our outage. `no_data` — the window falls outside the ' +
              'period we hold. `out_of_scope` — we hold nothing for this pair at any time, ' +
              'and no window will help.',
          },
          row_count: ROW_COUNT_META,
          row_limit: ROW_LIMIT_META,
          truncated: TRUNCATED_META,
          resolution: RESOLUTION_META,
          resolution_uniform: RESOLUTION_UNIFORM_META,
          series: seriesMeta(`${SERIES_META_DESCRIPTION} ${seriesNote}`),
          freshness: { $ref: '#/components/schemas/Freshness' },
          excluded: {
            type: 'array',
            description:
              'Row classes deliberately not served, named rather than dropped silently.',
            items: { $ref: '#/components/schemas/ExcludedNote' },
          },
        },
        required: [
          'resource',
          'zone',
          'from',
          'to',
          'coverage',
          'row_count',
          'row_limit',
          'truncated',
          'resolution',
          'resolution_uniform',
          'series',
          'freshness',
          'excluded',
        ],
        additionalProperties: false,
      },
      links: { $ref: '#/components/schemas/PagedLinks' },
    },
    required: ['data', 'meta', 'links'],
    additionalProperties: false,
  };
}

function forecastMeta(resource: string, pageable: boolean): Schema {
  return {
    type: 'object',
    properties: {
      resource: { type: 'string', const: resource },
      zone: ZONE_META,
      forecast_type: {
        type: 'string',
        enum: [...PUBLIC_FORECAST_TYPE_IDS],
        description: 'The forecast type this response is about, echoed from the request.',
      },
      model: {
        type: ['string', 'null'],
        enum: [...PUBLIC_FORECAST_MODELS, null],
        description:
          'The model that actually served. When you did not name one, this is the first ' +
          'served model with rows for your zone, type and window — the two models cover ' +
          'disjoint zone sets, so a fixed choice would blank zones rather than harmonise ' +
          'them. `null` when no model has rows for this zone and type at all. An explicit ' +
          '`model=` is honoured strictly and never substituted.',
      },
      horizon_hours: {
        type: ['integer', 'null'],
        description: 'The horizon filter applied, or `null` for every horizon in the window.',
      },
      from: timestamp(
        pageable
          ? 'Start of the served window, inclusive.'
          : 'First target interval in this run. Reported from the rows: this resource takes no window.'
      ),
      to: timestamp(
        pageable
          ? 'End of the served window, **exclusive**.'
          : 'Last target interval in this run. Reported from the rows, and **inclusive** here — unlike the window on the paged resources, this is an observed edge rather than a requested bound.'
      ),
      coverage: {
        type: 'string',
        enum: [...FORECAST_COVERAGE],
        description:
          '`ok` — rows were returned. `no_data` — we hold this series and this window is ' +
          'empty. `out_of_scope` — this model has never written for this zone and type. ' +
          '`upstream_gap` is deliberately never returned here: there is no upstream for our ' +
          'own model output, and a hole in it would be our run that did not happen.',
      },
      row_count: ROW_COUNT_META,
      row_limit: ROW_LIMIT_META,
      truncated: TRUNCATED_META,
      resolution: RESOLUTION_META,
      resolution_uniform: RESOLUTION_UNIFORM_META,
      series: seriesMeta(
        `${SERIES_META_DESCRIPTION} One entry: our forecast value, marked as ours with ` +
          '`attribution_required: false`.'
      ),
      latest_vintage_at: nullableTimestamp(
        'When the newest run for this zone, type and model was generated — how recently the ' +
          'model behind these numbers ran, regardless of which vintages the window selected.'
      ),
      freshness: { $ref: '#/components/schemas/Freshness' },
    },
    required: [
      'resource',
      'zone',
      'forecast_type',
      'model',
      'horizon_hours',
      'from',
      'to',
      'coverage',
      'row_count',
      'row_limit',
      'truncated',
      'resolution',
      'resolution_uniform',
      'series',
      'latest_vintage_at',
      'freshness',
    ],
    additionalProperties: false,
  };
}

const CATALOG_META: Schema = {
  type: 'object',
  description:
    'Lighter than the data endpoints’ envelope on purpose: these three return metadata ' +
    'rather than a time series, so there is no window, no resolution and no row cap to ' +
    'report, and fields that would be `null` on every response are absent rather than ' +
    'inviting a client to branch on them.',
  properties: {
    resource: { type: 'string', description: 'Which catalogue resource produced this.' },
    row_count: ROW_COUNT_META,
    generated_at: timestamp('When this payload was computed.'),
    map_built_at: timestamp(
      'When the memoized fleet map behind this response was built. Distinct from ' +
        '`generated_at`: the map refreshes on a timer, so a freshly computed response can ' +
        'rest on a map that is up to that old, and saying so is cheaper than implying a ' +
        'per-request scan we deliberately do not do.'
    ),
  },
  required: ['resource', 'row_count', 'generated_at', 'map_built_at'],
  additionalProperties: false,
};

function catalogResponse(title: string, resource: string, rowRef: string): Schema {
  return {
    type: 'object',
    title,
    properties: {
      data: { type: 'array', items: { $ref: rowRef } },
      meta: {
        ...CATALOG_META,
        properties: {
          ...(CATALOG_META.properties as Schema),
          resource: { type: 'string', const: resource },
        },
      },
      links: { $ref: '#/components/schemas/Links' },
    },
    required: ['data', 'meta', 'links'],
    additionalProperties: false,
  };
}

const ZONE_STREAM_STATE_PROPERTIES: Schema = {
  data_from: nullableTimestamp('Oldest row we hold. `null` when we hold none.'),
  data_through: nullableTimestamp(
    'Newest row we hold. `null` when we hold none, and legitimately in the future for a ' +
      'day-ahead series.'
  ),
  source_checked_at: nullableTimestamp('When we last attempted an upstream pass for this pair.'),
  status: {
    type: 'string',
    enum: [...FRESHNESS_STATUSES],
    description: 'As on `meta.freshness.status`. `none` where we hold nothing for this pair.',
  },
  source: { $ref: '#/components/schemas/SeriesSource' },
};

const CATALOG_ZONE_SCHEMA: Schema = {
  type: 'object',
  title: 'CatalogZone',
  description:
    'One zone, with the span and status of each observation stream. Zones we hold nothing ' +
    'for are **kept**, with `status: "none"` on each stream: dropping them would answer ' +
    '"do you cover XX" with silence, and an absence you cannot distinguish from an omission ' +
    'is not an answer.',
  properties: {
    zone: { type: 'string', description: 'Two-letter bidding-zone code.' },
    streams: {
      type: 'array',
      minItems: OBSERVATION_STREAMS.length,
      maxItems: OBSERVATION_STREAMS.length,
      items: {
        type: 'object',
        title: 'CatalogZoneStream',
        properties: {
          stream: { type: 'string', enum: [...OBSERVATION_STREAMS] },
          ...(ZONE_STREAM_STATE_PROPERTIES as Record<string, Schema>),
        },
        required: [
          'stream',
          'data_from',
          'data_through',
          'source_checked_at',
          'status',
          'source',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['zone', 'streams'],
  additionalProperties: false,
};

const CATALOG_MODEL_SCHEMA: Schema = {
  type: 'object',
  title: 'CatalogModel',
  description:
    'One (forecast type, model) pair and the zones it actually has rows for. Built from the ' +
    'rows rather than from a registry, so a model that returns nothing cannot appear here — ' +
    'which is the one thing a catalogue exists to prevent.',
  properties: {
    forecast_type: { type: 'string', enum: [...PUBLIC_FORECAST_TYPE_IDS] },
    model: { type: 'string', enum: [...PUBLIC_FORECAST_MODELS] },
    stability: {
      type: 'string',
      enum: [...STABILITIES],
      description:
        'How confident the offer is, from measured coverage. `stable` types carry a ' +
        'production-model forecast across most zones we hold; `beta` types reach a handful. ' +
        'Published rather than hidden behind a type list so that a plan bought for a market ' +
        'we barely cover is a visible decision.',
    },
    unit: { type: 'string', enum: [...UNITS] },
    zone_count: { type: 'integer', description: 'Length of `zones`.' },
    zones: {
      type: 'array',
      items: { type: 'string' },
      description: 'Zones with at least one row for this type and model, sorted.',
    },
    source: { $ref: '#/components/schemas/SeriesSource' },
  },
  required: ['forecast_type', 'model', 'stability', 'unit', 'zone_count', 'zones', 'source'],
  additionalProperties: false,
};

const COVERAGE_GAP_SCHEMA: Schema = {
  type: 'object',
  title: 'CoverageGap',
  description: 'A hole in the window, measured from the returned timestamps rather than assumed.',
  properties: {
    from: timestamp('First missing interval, inclusive.'),
    to: timestamp('First present interval after the gap, exclusive.'),
    missing_intervals: {
      type: 'integer',
      description: 'How many intervals of the observed resolution are missing.',
    },
  },
  required: ['from', 'to', 'missing_intervals'],
  additionalProperties: false,
};

const CATALOG_COVERAGE_SCHEMA: Schema = {
  type: 'object',
  title: 'CatalogCoverage',
  description:
    'Coverage of one zone and stream: the span always, the holes on request. This is the ' +
    'resource that stops you inferring "this zone had no load" from an empty array when the ' +
    'truth is "the publisher stopped on a particular date" — absence a data response cannot ' +
    'narrate without inventing rows.',
  properties: {
    zone: { type: 'string' },
    stream: { type: 'string', enum: [...OBSERVATION_STREAMS] },
    ...(ZONE_STREAM_STATE_PROPERTIES as Record<string, Schema>),
    window: {
      type: 'object',
      title: 'CatalogCoverageWindow',
      description:
        'Present only when `from` and `to` were both given. Without them this resource ' +
        'answers the cheap question from a memoized map; with them it reads the window’s ' +
        'timestamps and enumerates every hole.',
      properties: {
        from: timestamp('Start of the examined window, inclusive.'),
        to: timestamp('End of the examined window, **exclusive**.'),
        row_count: { type: 'integer', description: 'Rows we hold and would serve in this window.' },
        resolution: RESOLUTION_META,
        excluded_row_count: {
          type: 'integer',
          description:
            'Rows in this window we decline to serve — see `meta.excluded` on the data ' +
            'resources for why. Counted rather than silently dropped, so this resource and ' +
            'the data resources cannot disagree about the same hour.',
        },
        gaps: { type: 'array', items: { $ref: '#/components/schemas/CoverageGap' } },
        gaps_truncated: {
          type: 'boolean',
          description: `Whether gap enumeration was cut short at \`max_gaps\`. Stated rather than left to be inferred from a list of exactly ${MAX_GAPS}.`,
        },
        max_gaps: {
          type: 'integer',
          const: MAX_GAPS,
          description: 'The most gaps one response will enumerate.',
        },
      },
      required: [
        'from',
        'to',
        'row_count',
        'resolution',
        'excluded_row_count',
        'gaps',
        'gaps_truncated',
        'max_gaps',
      ],
      additionalProperties: false,
    },
  },
  required: ['zone', 'stream', 'data_from', 'data_through', 'source_checked_at', 'status', 'source'],
  additionalProperties: false,
};

const ERROR_SCHEMA: Schema = {
  type: 'object',
  title: 'Error',
  description:
    'The error body, on every non-2xx response. Failure is signalled by the HTTP status; ' +
    'there is no `success` flag inside a 200 to forget to check. **No message ever echoes ' +
    'what you sent** — every string is a constant that describes the expected form, so a ' +
    'body you paste into a public issue tracker carries nothing of yours and nothing of ours.',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'Stable machine handle for the failure. Branch on this rather than on `message`. ' +
            'Authentication and authorisation: ' +
            Object.values(AUTH_ERROR_CODES)
              .map((code) => `\`${code}\``)
              .join(', ') +
            '. Throttling: ' +
            Object.values(THROTTLE_ERROR_CODES)
              .map((code) => `\`${code}\``)
              .join(', ') +
            '. Request validation codes name the parameter — `zone_required`, ' +
            '`invalid_from`, `window_too_large`, `empty_window`, `invalid_cursor` and so on.',
        },
        message: { type: 'string', description: 'Written for a person to read. Never parsed.' },
      },
      required: ['code', 'message'],
      additionalProperties: false,
    },
  },
  required: ['error'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

function queryParameter(
  name: string,
  required: boolean,
  schema: Schema,
  description: string,
  extra: Schema = {}
): Schema {
  return { name, in: 'query', required, description, schema, ...extra };
}

const ZONE_PARAM = queryParameter(
  'zone',
  true,
  { type: 'string', pattern: '^[A-Za-z]{2}$' },
  'Bidding-zone code, two letters — `DE`. One zone per request. Validated by shape rather ' +
    'than against a list: a well-formed zone we hold nothing for returns an empty page with ' +
    'a coverage reason rather than a 400, so you never have to hardcode our zone list to ' +
    'avoid one. `GET /v1/catalog/zones` is the list.'
);

const FROM_PARAM = queryParameter(
  'from',
  true,
  { type: 'string' },
  `Start of the window, inclusive. RFC 3339 UTC with an explicit \`Z\`, or a bare date ` +
    `(\`2026-08-01\`, read as midnight UTC). Fractional seconds are accepted and truncated. ` +
    `Local times and UTC offsets are refused: a naive timestamp is the one input where being ` +
    `wrong is invisible — it parses, it returns rows, and the rows are shifted by your offset.`
);

const TO_PARAM = queryParameter(
  'to',
  true,
  { type: 'string' },
  `End of the window, **exclusive**. Both bounds are required and neither defaults: a ` +
    `default ending at "now" would silently truncate tomorrow from every day-ahead series. ` +
    `A single request may span at most ${MAX_WINDOW_DAYS} days.`
);

const LIMIT_PARAM = queryParameter(
  'limit',
  false,
  { type: 'integer', minimum: 1, maximum: MAX_ROW_LIMIT, default: MAX_ROW_LIMIT },
  `Maximum rows to return. Defaults to the cap of ${MAX_ROW_LIMIT}, which is also the ` +
    `ceiling — asking for more returns the cap rather than a 400, with \`meta.row_limit\` ` +
    `stating what was applied. The cap is a term of the contract, not a plan setting.`
);

const CURSOR_PARAM = queryParameter(
  'cursor',
  false,
  { type: 'string' },
  'Opaque cursor from a previous response’s `links.next`. It is fingerprinted against ' +
    'the query that minted it, so replaying one against different parameters is a 400 rather ' +
    'than a page of unrelated rows presented as page two.'
);

const HORIZON_PARAM = queryParameter(
  'horizon',
  false,
  { type: 'integer', minimum: 0, maximum: MAX_HORIZON_HOURS },
  `Restrict to one forecast horizon, in hours. Hours rather than "D+1"/"D+2" bands, which ` +
    `would freeze a UI shorthand into a contract. The longest horizon this data reaches is ` +
    `${MAX_HORIZON_HOURS} hours; there is no D+3, and we do not manufacture one.`
);

const MODEL_PARAM = queryParameter(
  'model',
  false,
  { type: 'string', enum: [...PUBLIC_FORECAST_MODELS] },
  'Pin the model. Honoured **strictly**: if the model you named has no rows for this zone ' +
    'and window you get an empty page with a coverage reason, never the other model’s ' +
    'numbers under the name you asked for. Omit it to get whichever model actually covers ' +
    'your zone, named back to you in `meta.model`.'
);

const PRODUCTION_TYPE_PARAM = queryParameter(
  'production_type',
  false,
  { type: 'array', items: { type: 'string', enum: [...PRODUCTION_TYPES] } },
  'Comma-separated subset of production types. Omit for all 21. Narrowing is the only thing ' +
    'it does: a type the zone does not report is still present and `null` when you ask for ' +
    'it by name. An unknown member is a 400 rather than an ignored filter — silently ' +
    'dropping a typo returns all 21 types, which reads as success and bills as success.',
  { style: 'form', explode: false }
);

function typeParam(ids: readonly string[], note: string): Schema {
  return queryParameter(
    'type',
    true,
    { type: 'string', enum: [...ids] },
    `Which forecast type. ${note}`
  );
}

const FORECAST_TYPE_NOTE =
  'Stability per type is published by `GET /v1/catalog/models`: ' +
  PUBLIC_FORECAST_TYPES.map((type) => `\`${type.id}\` (${type.stability})`).join(', ') +
  '. `net_position` is not served.';

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const AUTH_RESPONSES: Schema = {
  '400': {
    description: 'The request could not be understood. `error.code` names the parameter.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '401': {
    description:
      'No API key, or a key that is missing, malformed, invalid, revoked or expired. Carries ' +
      '`WWW-Authenticate: Bearer`.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '403': {
    description: 'The key is valid but the account is disabled.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '404': {
    description: 'No such resource.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '429': {
    description:
      'The per-minute rate limit, the monthly quota, or the overage cap. `error.code` says ' +
      'which, and it matters: a rate limit is transient and `Retry-After` is seconds, while a ' +
      'monthly quota is not and retrying with backoff will fail for the rest of the month.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
};

function operation(config: {
  operationId: string;
  summary: string;
  description: string;
  tag: string;
  parameters: Schema[];
  responseSchema: string;
  responseDescription: string;
}): Schema {
  return {
    operationId: config.operationId,
    summary: config.summary,
    description: config.description,
    tags: [config.tag],
    parameters: config.parameters,
    responses: {
      '200': {
        description: config.responseDescription,
        content: {
          'application/json': { schema: { $ref: `#/components/schemas/${config.responseSchema}` } },
        },
      },
      ...AUTH_RESPONSES,
    },
  };
}

const OBSERVATION_STREAM_NOTES: Record<string, { summary: string; row: string; series: string }> = {
  load: {
    summary: 'Actual electricity consumption',
    row: 'LoadRow',
    series: 'One entry: load in MW.',
  },
  price: {
    summary: 'Day-ahead electricity prices',
    row: 'PriceRow',
    series: 'One entry: price in EUR/MWh, and it is signed — negative prices are real.',
  },
  generation: {
    summary: 'Actual generation by production type',
    row: 'GenerationRow',
    series: `Up to ${PRODUCTION_TYPES.length} entries, one per production type returned — the response that carries the most series at once, each with its own source and licence.`,
  },
};

export interface OpenApiDocument extends Record<string, unknown> {
  openapi: string;
  info: Record<string, unknown>;
  paths: Record<string, unknown>;
  components: { schemas: Record<string, Schema>; securitySchemes: Record<string, Schema> };
}

/**
 * Build the document.
 *
 * Pure and deterministic — no clock, no environment, no filesystem — because
 * `drift.test.ts` compares the committed artifact against a fresh build, and a
 * build that varied between runs would make that comparison useless.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  const paths: Record<string, unknown> = {};

  paths['/v1'] = {
    get: {
      operationId: 'getRoot',
      summary: 'Discovery root',
      description:
        'Two constants, and the only resource on this API that needs no key: a client ' +
        'checking that it is pointed at a `/v1` at all should not need a credential to find ' +
        'out. It deliberately reports nothing operational — not whether a key store is ' +
        'configured, not a build, not a database — because answering that to an ' +
        'unauthenticated caller turns a liveness probe into reconnaissance. Every other path ' +
        'under `/v1` answers 401 without a key, **including paths that do not exist**, so the ' +
        'surface cannot be enumerated without one.',
      tags: ['Discovery'],
      security: [],
      responses: {
        '200': {
          description: 'The API version this server speaks.',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/DiscoveryResponse' } },
          },
        },
      },
    },
  };

  for (const stream of OBSERVATION_STREAMS) {
    const note = OBSERVATION_STREAM_NOTES[stream];
    paths[`/v1/observations/${stream}`] = {
      get: operation({
        operationId: `getObservations${stream[0].toUpperCase()}${stream.slice(1)}`,
        summary: note.summary,
        description:
          `ENTSO-E-derived history for one zone over a half-open window. Timestamps label ` +
          `the **start** of each interval. Rows are never interpolated, forward-filled or ` +
          `carried across a gap, and an empty page always says why in \`meta.coverage\`.` +
          (stream === 'load'
            ? ' Stored zeros are excluded rather than served: a national grid never draws 0 MW, and those rows are an ingest placeholder rather than a measurement.'
            : ''),
        tag: 'Observations',
        parameters:
          stream === 'generation'
            ? [ZONE_PARAM, FROM_PARAM, TO_PARAM, PRODUCTION_TYPE_PARAM, LIMIT_PARAM, CURSOR_PARAM]
            : [ZONE_PARAM, FROM_PARAM, TO_PARAM, LIMIT_PARAM, CURSOR_PARAM],
        responseSchema: `Observations${stream[0].toUpperCase()}${stream.slice(1)}Response`,
        responseDescription: `A page of ${stream} observations.`,
      }),
    };
  }

  paths['/v1/forecasts'] = {
    get: operation({
      operationId: 'getForecasts',
      summary: 'Our forecasts over a window',
      description:
        'One value per target interval, from the newest run that covers it — never a stitch ' +
        'of several runs, which would produce discontinuities at the seams that no model ever ' +
        'emitted. Three constraints are published rather than left to be discovered: the ' +
        `horizon stops at ${MAX_HORIZON_HOURS} hours (there is no D+3), the history is about ` +
        'seven and a half months deep, and coverage is per type and per zone and is thin for ' +
        'most of the beta types. `GET /v1/catalog/models` publishes the measured coverage.',
      tag: 'Forecasts',
      parameters: [
        ZONE_PARAM,
        typeParam(PUBLIC_FORECAST_TYPE_IDS, FORECAST_TYPE_NOTE),
        FROM_PARAM,
        TO_PARAM,
        HORIZON_PARAM,
        MODEL_PARAM,
        LIMIT_PARAM,
        CURSOR_PARAM,
      ],
      responseSchema: 'ForecastsResponse',
      responseDescription: 'A page of forecast values.',
    }),
  };

  paths['/v1/forecasts/latest'] = {
    get: operation({
      operationId: 'getLatestForecast',
      summary: 'The newest complete run, whole',
      description:
        'The newest **run**, not the newest value per target hour. Takes no window and is ' +
        `never paged: one run is bounded by the horizon, so at most ${MAX_HORIZON_HOURS} rows. ` +
        'Every row carries `generated_at`, which is what makes this honest at 03:00 UTC when ' +
        'the newest vintage is eight hours old — our runs stop at 19:00 and resume at 07:00.',
      tag: 'Forecasts',
      parameters: [ZONE_PARAM, typeParam(PUBLIC_FORECAST_TYPE_IDS, FORECAST_TYPE_NOTE), MODEL_PARAM],
      responseSchema: 'ForecastsLatestResponse',
      responseDescription: 'One complete forecast run.',
    }),
  };

  paths['/v1/accuracy'] = {
    get: operation({
      operationId: 'getAccuracy',
      summary: 'How our forecasts actually performed',
      description:
        'Forecast-versus-actual metrics over a window, reduced to one row. Read ' +
        '`meta.coverage` before the numbers: a window we could not measure returns `null` ' +
        'metrics, never `0`, because `0` means a flawless forecast. `meta.forecast_hours` is ' +
        'the denominator `sample_size` is the numerator of — a metric computed over a third ' +
        'of a window should not look like one computed over all of it.\n\n' +
        'Where our database holds the same country-hour under two stored timestamp forms ' +
        'with different values, the space-form row is the one scored, and ' +
        '`meta.conflict_convention` says so on every response. Which of a conflicting pair is ' +
        'authoritative is an open question internally; publishing the convention means a ' +
        'later ruling is a documented change rather than a silent correction to numbers you ' +
        'have already used.\n\n' +
        'Some forecast types this API serves are refused here — ' +
        `\`${PUBLIC_FORECAST_TYPE_IDS.filter((id) => !ACCURACY_TYPE_IDS.includes(id)).join('`, `')}\` — ` +
        'because which stored column their actual *is* is not settled, and picking one in ' +
        'order to return a number would be answering that question by accident.',
      tag: 'Accuracy',
      parameters: [
        ZONE_PARAM,
        typeParam(
          ACCURACY_TYPE_IDS,
          'Narrower than the forecast type list: a type whose actual is not settled is refused rather than scored against a guessed column.'
        ),
        FROM_PARAM,
        TO_PARAM,
        HORIZON_PARAM,
        MODEL_PARAM,
      ],
      responseSchema: 'AccuracyResponse',
      responseDescription: 'One row of metrics, measurable or explicitly not.',
    }),
  };

  paths['/v1/catalog/zones'] = {
    get: operation({
      operationId: 'getCatalogZones',
      summary: 'Every zone we hold, and the span of each stream',
      description:
        'Zones we hold nothing for are listed with `status: "none"` rather than omitted. A ' +
        'zone list alone would not do this job — a stream that stopped years ago and one that ' +
        'is live look identical in a list, and both look like coverage.',
      tag: 'Catalog',
      parameters: [],
      responseSchema: 'CatalogZonesResponse',
      responseDescription: 'Every zone, with per-stream span and status.',
    }),
  };

  paths['/v1/catalog/models'] = {
    get: operation({
      operationId: 'getCatalogModels',
      summary: 'Forecast types and models, filtered by measured coverage',
      description:
        'A query over the rows, not a reading of a registry: a model with no rows cannot ' +
        'appear in the output of a group-by over its rows. A type for which no model has ' +
        'written is omitted entirely rather than listed with an empty zone array — an entry ' +
        'with no zones is an offer with nothing behind it.',
      tag: 'Catalog',
      parameters: [],
      responseSchema: 'CatalogModelsResponse',
      responseDescription: 'Every (type, model) pair that has rows, with its zone list.',
    }),
  };

  paths['/v1/catalog/coverage'] = {
    get: operation({
      operationId: 'getCatalogCoverage',
      summary: 'Coverage of one zone and stream, with the holes enumerated',
      description:
        'Without `from`/`to`, the cheap question: what period do we hold, and is it live. ' +
        'With them, the expensive one: exactly where the holes are. Both must be given ' +
        'together — one alone is a request that cannot be honoured either way, and guessing ' +
        'the other end is how you end up billed for a window you did not ask for.',
      tag: 'Catalog',
      parameters: [
        ZONE_PARAM,
        queryParameter(
          'stream',
          true,
          { type: 'string', enum: [...OBSERVATION_STREAMS] },
          'Which observation stream to report coverage for.'
        ),
        { ...FROM_PARAM, required: false },
        { ...TO_PARAM, required: false },
      ],
      responseSchema: 'CatalogCoverageResponse',
      responseDescription: 'One coverage record, with a `window` block when a window was given.',
    }),
  };

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Able Energy /v1',
      version: DOCUMENT_VERSION,
      summary: 'European electricity observations, forecasts and forecast accuracy.',
      description:
        'A read-only JSON API over European electricity data: ENTSO-E-derived observations ' +
        '(load, day-ahead price, generation by production type), our own forecasts, forecast ' +
        'accuracy against actuals, and a catalogue that says what we hold.\n\n' +
        '### Four rules that hold everywhere\n\n' +
        '1. **Every series names its source and licence.** `meta.series[].source` carries the ' +
        'origin, the licence and the exact attribution line to render. It is on our own ' +
        'output too, marked `attribution_required: false`, so you can branch on one field ' +
        'instead of maintaining a list of which of our fields came from where.\n' +
        '2. **Absence is never a silent zero.** A production type a zone does not report is ' +
        '`null`, not `0`. A gap is a gap: nothing is interpolated, forward-filled or carried ' +
        'across a missing interval. An empty page carries a `coverage` reason saying whose ' +
        'absence it is.\n' +
        '3. **Windows are half-open and always UTC.** `from` is included, `to` is not. Every ' +
        'timestamp on the wire is RFC 3339 UTC with an explicit `Z` at second precision, and ' +
        'each labels the start of its interval.\n' +
        '4. **Every response is paged and capped.** `meta.row_limit` states the cap that was ' +
        'applied and `meta.truncated` says whether it bit; follow `links.next` until it is ' +
        '`null`.\n\n' +
        '### Attribution\n\n' +
        `Observation series are derived from the ${ENTSOE_OBSERVATION.name} and are licensed ` +
        `${ENTSOE_OBSERVATION.licence}. Where \`attribution_required\` is \`true\`, render the ` +
        '`attribution` string as given — that obligation flows from the upstream licence and ' +
        'cannot be waived by us. Forecast output is ours.',
    },
    servers: [
      {
        url: '/',
        description:
          'Relative to the host you reach this API on. No absolute server URL is published: ' +
          'the deployment address is not settled, and a URL in a published document is one ' +
          'a client will hardcode.',
      },
    ],
    tags: [
      { name: 'Discovery', description: 'The one resource that needs no key.' },
      { name: 'Observations', description: 'ENTSO-E-derived history.' },
      { name: 'Forecasts', description: 'Our own model output.' },
      { name: 'Accuracy', description: 'How that output performed against actuals.' },
      { name: 'Catalog', description: 'What we hold, stated rather than inferred.' },
    ],
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An API key, sent as `Authorization: Bearer able_live_<prefix>_<secret>`. Never a ' +
            'cookie and never a query parameter — a credential in a URL ends up in logs, ' +
            'browser history and referrer headers. Every path under `/v1` except the ' +
            'discovery root requires one, including paths that do not exist.',
        },
      },
      schemas: {
        SeriesSource: SERIES_SOURCE_SCHEMA,
        SeriesDescriptor: SERIES_DESCRIPTOR_SCHEMA,
        Freshness: FRESHNESS_SCHEMA,
        ExcludedNote: EXCLUDED_NOTE_SCHEMA,
        CoverageGap: COVERAGE_GAP_SCHEMA,
        Links: linksSchema(false),
        PagedLinks: linksSchema(true),
        Error: ERROR_SCHEMA,

        DiscoveryResponse: {
          type: 'object',
          title: 'DiscoveryResponse',
          properties: {
            version: { type: 'string', const: 'v1' },
            status: { type: 'string', const: 'ok' },
          },
          required: ['version', 'status'],
          additionalProperties: false,
        },

        LoadRow: singleSeriesRow('LoadRow', 'load', 'MW', 'Actual electricity consumption.'),
        PriceRow: singleSeriesRow(
          'PriceRow',
          'price',
          'EUR/MWh',
          'Day-ahead price. **Negative values are real** and are not errors.'
        ),
        GenerationRow: GENERATION_ROW_SCHEMA,
        ForecastRow: FORECAST_ROW_SCHEMA,
        AccuracyRow: ACCURACY_ROW_SCHEMA,

        ObservationsLoadResponse: observationsResponse(
          'load',
          '#/components/schemas/LoadRow',
          OBSERVATION_STREAM_NOTES.load.series
        ),
        ObservationsPriceResponse: observationsResponse(
          'price',
          '#/components/schemas/PriceRow',
          OBSERVATION_STREAM_NOTES.price.series
        ),
        ObservationsGenerationResponse: observationsResponse(
          'generation',
          '#/components/schemas/GenerationRow',
          OBSERVATION_STREAM_NOTES.generation.series
        ),

        ForecastsResponse: {
          type: 'object',
          title: 'ForecastsResponse',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/ForecastRow' } },
            meta: forecastMeta('forecasts', true),
            links: { $ref: '#/components/schemas/PagedLinks' },
          },
          required: ['data', 'meta', 'links'],
          additionalProperties: false,
        },
        ForecastsLatestResponse: {
          type: 'object',
          title: 'ForecastsLatestResponse',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/ForecastRow' } },
            meta: forecastMeta('forecasts.latest', false),
            links: { $ref: '#/components/schemas/Links' },
          },
          required: ['data', 'meta', 'links'],
          additionalProperties: false,
        },

        AccuracyResponse: {
          type: 'object',
          title: 'AccuracyResponse',
          properties: {
            data: {
              type: 'array',
              minItems: 1,
              maxItems: 1,
              items: { $ref: '#/components/schemas/AccuracyRow' },
            },
            meta: {
              type: 'object',
              properties: {
                resource: { type: 'string', const: 'accuracy' },
                zone: ZONE_META,
                forecast_type: { type: 'string', enum: [...ACCURACY_TYPE_IDS] },
                model: {
                  type: ['string', 'null'],
                  enum: [...PUBLIC_FORECAST_MODELS, null],
                  description:
                    'The model these numbers are about. Accuracy without the model is not a ' +
                    'fact: the two models cover disjoint zone sets, so "our load forecast for ' +
                    'a zone" and "this model’s load forecast for that zone" are different ' +
                    'claims and only one of them may be measurable.',
                },
                horizon_hours: {
                  type: ['integer', 'null'],
                  description: 'The horizon filter applied, or `null` for every horizon.',
                },
                from: timestamp('Start of the measured window, inclusive.'),
                to: timestamp('End of the measured window, **exclusive**.'),
                coverage: {
                  type: 'string',
                  enum: [...ACCURACY_COVERAGE],
                  description:
                    '**Read this before the metrics.** `ok` — something paired. ' +
                    '`no_model_coverage` — this model has no forecast rows for this zone, ' +
                    'type and window at all; a normal answer, not an error, because the two ' +
                    'models cover disjoint zones. `no_paired_actuals` — we forecast this ' +
                    'window and no actual lined up against it: a window in the future, or ' +
                    'actuals not ingested yet. The remedies differ — ask a different model, ' +
                    'versus wait.',
                },
                forecast_hours: {
                  type: 'integer',
                  description:
                    'Distinct target hours the model forecast in this window — the ' +
                    'denominator `sample_size` is the numerator of. The two are routinely far ' +
                    'apart and the gap is information: `forecast_hours: 744, sample_size: 500` ' +
                    'means the figure covers two thirds of the window.',
                },
                row_count: { type: 'integer', const: 1 },
                row_limit: { type: 'integer', const: 1 },
                truncated: { type: 'boolean', const: false },
                resolution: {
                  type: 'null',
                  description:
                    'Always `null`: an aggregate has no observed spacing, and reporting the ' +
                    'window’s nominal resolution would describe the rows that went in ' +
                    'rather than the row that comes out.',
                },
                resolution_uniform: { type: 'null', description: 'Always `null`, as `resolution` is.' },
                series: seriesMeta(
                  `${SERIES_META_DESCRIPTION} Five entries and **two units** in one response — ` +
                    '`mape`/`wape`/`smape` are percentages, `mae`/`rmse` are in the unit of ' +
                    'whatever was forecast. All five are marked as our output: the reduction is ' +
                    'our computation, and the ENTSO-E observation it was computed against is ' +
                    'separately available under its own CC-BY series block at `/v1/observations`.'
                ),
                latest_vintage_at: nullableTimestamp(
                  'When the newest run of this model for this zone and type was generated.'
                ),
                conflict_convention: {
                  type: 'string',
                  const: 'space_preferred',
                  description:
                    'How a conflicting stored-timestamp pair is resolved when scoring. ' +
                    'Published on every response so that a later change is a documented change ' +
                    'to a stated convention rather than a silent correction.',
                },
                freshness: {
                  $ref: '#/components/schemas/Freshness',
                  description:
                    'The **actuals** stream, not the forecast one: accuracy cannot be measured ' +
                    'past the newest actual we hold, so that is the edge that bounds this ' +
                    'answer. `latest_vintage_at` carries the forecast side.',
                },
              },
              required: [
                'resource',
                'zone',
                'forecast_type',
                'model',
                'horizon_hours',
                'from',
                'to',
                'coverage',
                'forecast_hours',
                'row_count',
                'row_limit',
                'truncated',
                'resolution',
                'resolution_uniform',
                'series',
                'latest_vintage_at',
                'conflict_convention',
                'freshness',
              ],
              additionalProperties: false,
            },
            links: { $ref: '#/components/schemas/Links' },
          },
          required: ['data', 'meta', 'links'],
          additionalProperties: false,
        },

        CatalogZone: CATALOG_ZONE_SCHEMA,
        CatalogModel: CATALOG_MODEL_SCHEMA,
        CatalogCoverage: CATALOG_COVERAGE_SCHEMA,
        CatalogZonesResponse: catalogResponse(
          'CatalogZonesResponse',
          'catalog.zones',
          '#/components/schemas/CatalogZone'
        ),
        CatalogModelsResponse: catalogResponse(
          'CatalogModelsResponse',
          'catalog.models',
          '#/components/schemas/CatalogModel'
        ),
        CatalogCoverageResponse: catalogResponse(
          'CatalogCoverageResponse',
          'catalog.coverage',
          '#/components/schemas/CatalogCoverage'
        ),
      },
    },
  };
}

/**
 * The document as it is committed: two-space JSON with a trailing newline.
 *
 * One function so the generator and the drift check cannot disagree about
 * formatting and report a whitespace difference as a contract change.
 */
export function renderOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
