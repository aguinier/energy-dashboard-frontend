/**
 * Is a country's ENTSO-E realized load on the same basis as its ENTSO-E TSO
 * load forecast?
 *
 * Subtracting one from the other only measures *forecast error* when both
 * series measure the same quantity. For at least one country they do not, and
 * the difference is then a definitional gap wearing the costume of a forecast
 * miss. Publishing that as MAE/MAPE/RMSE is this repo's recurring defect —
 * an arithmetically correct number under a false claim.
 *
 * This module is deliberately a **registry of measured findings**, not an
 * inferred threshold. A threshold was considered and rejected: measured across
 * the 34 countries with a stored D+1 load forecast, there is no gap in the
 * MAPE distribution to put one in. FR reached 11.6% and DK 11.0% in
 * 2025-06-01..15 through ordinary forecast error, while EE and IE sit at
 * ~10.5% in 2026-08-04..11. Any cutoff that catches the latter condemns the
 * former, and an uncalibrated cutoff is exactly what `METRIC_THRESHOLDS` was
 * deleted for (see CLAUDE.md, "Colouring a WAPE is a ranking, never a grade").
 *
 * So an entry is added only once the divergence has been established against
 * the raw upstream documents, and it carries the evidence that established it.
 */

/**
 * `divergent_basis` says the two series measure different quantities, so no
 * accuracy figure derived from the pair is publishable. It is deliberately
 * NOT one of the "no data" words: we hold both series in full, and reporting
 * this as absence would be a different false claim.
 */
export type LoadForecastBasis = 'comparable' | 'divergent_basis';

export interface DivergentLoadBasis {
  /**
   * One sentence, rendered to the reader in place of the suppressed numbers.
   * States what the gap *is*, never that data is missing.
   */
  reason: string;
  /**
   * The same finding said for a withheld forecast **series** rather than a
   * withheld measure (ABL-501).
   *
   * A separate sentence rather than a reuse of `reason`, because the two
   * describe different things and the reader is looking at different evidence.
   * `reason` answers "why is this accuracy cell empty" and opens *Not
   * measurable here*; on a chart nothing was being measured — a line was being
   * drawn — and the honest lead is that it was withheld. The half that carries
   * the finding is identical in both, and it is stated once per sentence
   * rather than assembled from fragments, so neither can be rendered as a
   * clause that reads oddly on its own.
   */
  seriesReason: string;
  /** When the finding was measured against the upstream documents. */
  measuredOn: string;
}

/**
 * Countries whose realized load and TSO load forecast are published on
 * different bases.
 *
 * **NL** (ABL-277). Established by probing ENTSO-E directly on 2026-08-12 for
 * market day 2026-08-05: `A65`/`A16` (Actual Total Load) and `A65`/`A01`
 * (Day-ahead Total Load Forecast) for domain `10YNL----------L` both return a
 * single TimeSeries, businessType `A04`, objectAggregation `A01`, unit `MAW`,
 * resolution `PT15M` — and disagree at source (realized 3,858.9–11,248.2 MW,
 * forecast 8,280.6–13,378.8 MW). Our stored rows reproduce both to the
 * decimal, so this is upstream, not our ingest: no aggregation or scaling
 * error, no bidding-zone mismatch, no partial-TSO coverage.
 *
 * The gap is behind-the-meter solar. ENTSO-E's *reported* NL solar generation
 * peaks at 181 MW on a cloudless August day against an installed Dutch fleet
 * well over 20 GW, so essentially the whole fleet is invisible as generation
 * and is netted out of the realized series but not the forecast. Seasonality
 * confirms it — measured over 2026-08-04..11 the midday bias (09–14 UTC) is
 * +123.2% against +9.8% overnight, while the same measurement over
 * 2026-01-06..20 gives +0.0% midday and −0.2% overnight. No solar, no
 * divergence.
 *
 * Suppression is unconditional rather than gated on season or on the size of
 * the observed error, and that is the point: in a window where the two happen
 * to agree, the difference is still not attributable to forecast skill. A
 * number we cannot attribute is not a number we can publish.
 *
 * **Our own ml model is on the gross basis too** (ABL-501, measured on the
 * replica 2026-08-20). This entry was written as a fact about the *TSO*
 * forecast, on the reasoning that our models are trained against the same
 * realized series they are scored on and so could not diverge. That reasoning
 * is plausible and the conclusion is false. Over 2026-08-04..11 the stored NL
 * load forecast is 100% `catboost` — no tso-named model writes into that table
 * for NL — and it carries the identical diurnal signature, larger than the
 * TSO's:
 *
 * | window | midday bias (09–14 UTC) | overnight (21–05) | WAPE |
 * |---|---:|---:|---:|
 * | NL 2026-02-10..24 | −1.9% | +0.2% | 10.28% |
 * | NL 2026-06-10..24 | +138.2% | −3.6% | 31.46% |
 * | NL 2026-08-04..11 | +173.7% | −3.0% | 32.59% |
 * | DE 2026-08-04..11 | −0.5% | +3.3% | 8.18% |
 * | BE 2026-08-04..11 | −1.4% | −0.8% | 5.58% |
 *
 * Same proof, on the ml side: no solar, no divergence. A merely weak model
 * does not produce a clean midday-only bias that vanishes in winter, and
 * neither control shows any midday skew. The levels say what is being
 * predicted — NL midday August: realized 3,464 MW, ours 9,480 MW, ENTSO-E
 * D+1 8,073 MW, so our forecast is closer to the TSO's forecast (13.31% WAPE
 * against it) than either is to reality. Two forecasts of Dutch *gross* load.
 * The single clearest instance is one day at one pair of hours: on
 * 2026-08-05 catboost predicts 9,801 MW against a realized 9,909 MW at 03:00
 * and 9,431 MW against a realized 4,361 MW at 12:00.
 *
 * **Why** our model is on that basis — a gross training target, or a feature
 * that carries the basis in, such as an ENTSO-E day-ahead regressor — is not
 * established, is not visible from this repo, and is deliberately not guessed
 * at here. It is a question for the sibling `energy-forecast` repo and is
 * filed separately. What follows for *this* repo is only that the rule is a
 * property of the country's realized series, so it binds every forecast of
 * that series whoever produced it — which is why `withholdDivergentBasisSeries`
 * below takes no model argument.
 */
export const DIVERGENT_LOAD_BASIS: Readonly<Record<string, DivergentLoadBasis>> = {
  NL: {
    reason:
      'Not measurable here. ENTSO-E publishes the Dutch realized load net of ' +
      'behind-the-meter solar, while both its own day-ahead forecast and our ' +
      'model predict that load gross of it — so the difference between ' +
      'forecast and realized is a definitional gap, not forecast error.',
    seriesReason:
      'Forecast withheld. This is a forecast of Dutch load gross of ' +
      'behind-the-meter solar, while the realized series ENTSO-E publishes is ' +
      'net of it — a different quantity. Drawn together, the midday gap ' +
      'between the two lines would read as forecast error when it is solar.',
    measuredOn: '2026-08-12',
  },
};

/**
 * The forecast type every entry in `DIVERGENT_LOAD_BASIS` was established for.
 *
 * A caller that serves one forecast type from a load-only path needs no gate
 * — `tsoForecastService.getLoadForecastAccuracyMetrics` is one. A caller that
 * loops over several types must gate on this, and the cost of forgetting is
 * concrete: `/api/cross-country/metrics` spans eight types, so an ungated
 * application would blank NL's **price** and generation numbers as well.
 * Nothing has been measured about those pairs, so suppressing them would be a
 * second false claim in the opposite direction. Generation-side basis
 * divergence is a separate, still-open finding (ABL-400).
 */
export const DIVERGENT_BASIS_FORECAST_TYPE = 'load';

export interface LoadForecastBasisVerdict {
  basis: LoadForecastBasis;
  /** Non-null exactly when `basis` is `divergent_basis`. */
  basisNote: string | null;
}

/**
 * What a suppressed entry carries instead of the verdict pair above, on a
 * response whose comparable entries must stay byte-identical. See
 * `suppressIfDivergentBasis`.
 */
export interface DivergentBasisMarks {
  basis: 'divergent_basis';
  basisNote: string;
}

/**
 * Classify a country's realized-load-vs-load-forecast pair.
 *
 * Takes no model and no source: the finding is a property of the *realized*
 * series (what ENTSO-E nets out of it), so it binds every forecast of that
 * series — the TSO's, ours, and any future one — rather than singling out a
 * producer. ABL-501 measured that the ml side carries it too, which is
 * confirmation of that reading rather than a second finding.
 *
 * Case-insensitive, and an unknown country is `comparable` — the registry
 * records what has been *established*, so absence means "no finding", never
 * "verified fine".
 */
export function classifyLoadForecastBasis(countryCode: string): LoadForecastBasisVerdict {
  const entry = DIVERGENT_LOAD_BASIS[countryCode?.toUpperCase()];
  return entry
    ? { basis: 'divergent_basis', basisNote: entry.reason }
    : { basis: 'comparable', basisNote: null };
}

/**
 * Every measure produced by differencing the realized series against the
 * forecast — the whole set, named once, because a divergent basis invalidates
 * all of them at once.
 *
 * **`bias` is why this is a list rather than four assignments** (ABL-493).
 * `/api/cross-country/metrics` publishes it and `/tso-forecast/*` does not, so
 * routing the rule through the cross-country path by calling the existing
 * helper unchanged would have left `bias: -2063.27 MW` standing for NL — the
 * definitional gap restated in megawatts, under a heading that says forecast
 * error, and the one number on that response a reader would take as
 * actionable ("the TSO over-forecasts by 2 GW, they could correct that").
 *
 * Suppression is driven off this list at runtime, so a carrier that publishes
 * a measure already named here is covered whether or not anyone remembered it.
 * A *new* measure is caught by `MeasuresClassified` below.
 */
export const ERROR_MEASURES = ['mae', 'mape', 'wape', 'rmse', 'bias'] as const;
export type ErrorMeasure = (typeof ERROR_MEASURES)[number];

/**
 * Numeric fields that count how many rows paired up rather than how wrong they
 * were.
 *
 * These stay truthful. The points really did pair — we hold both series in
 * full — and zeroing them would assert "no data", a different and equally
 * false claim, the same distinction `degenerate_zero` draws against
 * `no_actuals` on the net-position side.
 */
export const PAIRING_COUNTS = ['dataPoints', 'mapeSamples'] as const;
export type PairingCount = (typeof PAIRING_COUNTS)[number];

/**
 * The D-7 seasonal-naive comparison, of which exactly one field is suppressed.
 *
 * `skillPct` is `100 * (1 - model_wape / baseline_wape)`, so it divides by the
 * contaminated model WAPE and inherits the whole defect — and it is the field
 * that renders the "worse than the D-7 naive baseline" badge, which was the
 * loudest wrong claim on the page (NL read `-136.8%`).
 *
 * `baselineWape` and `n` survive, and that asymmetry is deliberate rather than
 * an oversight. The baseline is the *actual* value from the same hour seven
 * days earlier (`skillScore.ts`), so `baselineWape` is
 * `100 * SUM|actual - actual_D7| / SUM|actual|` — realized against realized,
 * both terms net of behind-the-meter solar, both on the same basis. It is a
 * true statement about the country (Dutch load varies 13.09% week over week)
 * and blanking it would be this module's own rule misapplied: blank what is
 * unattributable, keep what is real, never assert absence.
 */
export interface SuppressibleSkill {
  skillPct: number | null;
}

/**
 * What `applyLoadForecastBasis` will accept and blank.
 *
 * Every field is optional because the two carriers genuinely differ — the TSO
 * accuracy shape has `mape`/`mapeSamples` and no `bias`, the cross-country
 * entry has `bias` and `skillVsSeasonalNaive` and no `mape`. Widening this was
 * the alternative to casting at one of the two call sites, and a cast is
 * exactly the thing that would let a measure through unblanked.
 *
 * ABL-388 made `wape` **required** here so a new error measure could not reach
 * a divergent-basis country by being forgotten, noting that an optional field
 * would have compiled. That property is not weakened by this change, it is
 * moved and strengthened: it now lives in `MeasuresClassified`, which fires at
 * the *response type's* definition site rather than on this parameter, and so
 * catches the case the old form could not — a measure added to a served shape
 * without ever being mentioned in this module at all.
 */
export interface SuppressibleLoadMetrics extends Partial<Record<ErrorMeasure, number | null>> {
  skillVsSeasonalNaive?: SuppressibleSkill;
}

/** Keys of `T` whose type is plain `number` (nullable or not). */
type NumericKeys<T> = {
  [K in keyof T]-?: number extends NonNullable<T[K]> ? K : never;
}[keyof T];

type Unclassified<T> = Exclude<NumericKeys<T>, ErrorMeasure | PairingCount>;

/**
 * Assign `true` to this beside any response type that publishes error
 * measures, in the ABL-305 `Exhaustive<…>` idiom.
 *
 * Every plain-numeric field on the shape must be classified: an
 * `ErrorMeasure` this module blanks, or a `PairingCount` it keeps. Add a sixth
 * measure to a served response and the assignment stops compiling and names
 * the field, instead of the measure quietly reaching a divergent-basis country
 * — which is the failure ABL-493 was filed for, in its next incarnation.
 *
 * It cannot see a measure nested inside an object field; `SuppressibleSkill`
 * is the one such case and is handled by name.
 */
export type MeasuresClassified<T> = [Unclassified<T>] extends [never]
  ? true
  : { unclassifiedNumericField: Unclassified<T> };

/**
 * Blank the error measures for a divergent pair, keeping the pairing counts.
 *
 * `dataPoints`/`mapeSamples` stay truthful: they describe how many rows paired
 * up, which is real, and zeroing them would assert "no data" — a different and
 * equally false claim, the same distinction `degenerate_zero` draws against
 * `no_actuals` on the net-position side.
 *
 * **`wape` is suppressed along with the rest, and it is worth saying why it is
 * not an exception.** WAPE is immune to the *near-zero-actual* defect that
 * makes NL's MAPE unreadable (ABL-388), so it is tempting to let it through as
 * the one honest number here. It is not one. This rule is not about a metric
 * behaving badly — it is about the two series measuring different quantities,
 * and a weighted average of a definitional gap is still a definitional gap.
 * Measured for NL load over 2026-08-04..11, the D+1 forecast runs +123.2%
 * against realized at midday and +9.8% overnight; WAPE reports that faithfully
 * and it is still not forecast error.
 */
export function applyLoadForecastBasis<T extends SuppressibleLoadMetrics>(
  countryCode: string,
  metrics: T,
): T & LoadForecastBasisVerdict {
  const verdict = classifyLoadForecastBasis(countryCode);
  if (verdict.basis === 'comparable') return { ...metrics, ...verdict };
  return { ...blankDerivedMeasures(metrics), ...verdict };
}

/**
 * The same rule, for a response whose comparable entries must not change at
 * all.
 *
 * `/api/cross-country/metrics` returns up to 34 countries across 8 forecast
 * types, and one measured finding covers one of those 272 cells. Stamping
 * `basis: 'comparable', basisNote: null` onto the other 271 would make every
 * entry in the response differ from the one before this rule existed, which
 * costs the cheapest check anyone has on a change like this — diff the payload
 * and confirm nothing moved but the country named. So a comparable entry is
 * returned **unchanged, by identity**, and absence of `basis` reads exactly the
 * way absence from `DIVERGENT_LOAD_BASIS` does: no finding, never "verified
 * fine".
 */
export function suppressIfDivergentBasis<T extends SuppressibleLoadMetrics>(
  countryCode: string,
  metrics: T,
): T | (T & DivergentBasisMarks) {
  const { basis, basisNote } = classifyLoadForecastBasis(countryCode);
  if (basis !== 'divergent_basis' || basisNote === null) return metrics;
  return { ...blankDerivedMeasures(metrics), basis, basisNote };
}

/**
 * A forecast series that was withheld, or served untouched, plus the reason.
 *
 * `withheldPoints` is the count of rows we hold and did not serve. It is the
 * series-level counterpart of `dataPoints` surviving suppression above, and it
 * carries the same claim: this is a *withholding*, not an absence. Zero rows
 * with `withheldPoints: 0` means the query found nothing; zero rows with
 * `withheldPoints: 96` means we have 96 and are not drawing them. Collapsing
 * those two into a bare empty array is what would let a withheld series be
 * reported to a reader as "no forecast published", which is false and is the
 * kind of false this module exists to stop.
 */
export interface WithheldForecastSeries<T> {
  data: T[];
  basis: LoadForecastBasis;
  basisNote: string | null;
  withheldPoints: number;
}

/**
 * The verdict for a forecast *series* of a given type, note worded for a chart.
 *
 * Gated on the forecast type for the reason `DIVERGENT_BASIS_FORECAST_TYPE`
 * gives, and the cost of forgetting is the same here as it is for the
 * measures: `/api/forecasts` serves eight types off one handler, so an ungated
 * application would blank NL's price, solar and wind overlays as well. Nothing
 * has been measured about those pairs (generation-side divergence is ABL-400,
 * still open), and withholding them would be a second false claim pointing the
 * other way.
 */
export function classifyForecastSeriesBasis(
  countryCode: string,
  forecastType: string,
): LoadForecastBasisVerdict {
  if (forecastType !== DIVERGENT_BASIS_FORECAST_TYPE) {
    return { basis: 'comparable', basisNote: null };
  }
  const entry = DIVERGENT_LOAD_BASIS[countryCode?.toUpperCase()];
  return entry
    ? { basis: 'divergent_basis', basisNote: entry.seriesReason }
    : { basis: 'comparable', basisNote: null };
}

/**
 * Withhold a forecast series whose basis does not match the actuals it will be
 * drawn against (ABL-501).
 *
 * The metric-level rule above stops a *number* derived from the pair from
 * being published. This stops the pair itself from being put on one axis,
 * which is the same defect one level up and was the more visible of the two:
 * measured through a local server on the replica 2026-08-20, NL's Load tab
 * drew a dashed forecast at 9,431 MW over a realized 4,361 MW at 12:00 on
 * 2026-08-05, with nothing on the card saying the two were different
 * quantities. A chart wrong by more than 2x is the incident class, and a
 * reader has no way to discover the gap from the picture.
 *
 * Withholding rather than annotating, and it is worth being explicit that the
 * rows are not junk. A degenerate net-position forecast (ABL-25) is
 * numerically unusable and there is nothing to lose by dropping it; a
 * gross-basis load forecast is a perfectly good prediction of a real
 * quantity. What it is not is a prediction of the series it is plotted
 * against, and the chart's whole claim — "here is the load, here is what we
 * said it would be" — is that claim. Drawing the line under a caveat was the
 * alternative and was rejected: the caveat is a sentence, the 2x gap is the
 * picture, and the picture is what gets read and screenshotted.
 *
 * Returns the rows **by identity** when there is no finding, so the series a
 * comparable country draws is unchanged point for point. Measured through a
 * local server on the replica 2026-08-20, sweeping 39 countries × 9 forecast
 * types: exactly 1 of 351 cells withholds (NL load, 168 points, catboost), the
 * other 85 non-empty cells serve what they served before, and NL keeps its
 * price and net-position overlays.
 *
 * The *response* is a different matter, and the difference from
 * `suppressIfDivergentBasis` is deliberate rather than an inconsistency. That
 * function returns a comparable entry wholly untouched, so 271 of 272
 * cross-country cells stay byte-identical and the payload diff stays the
 * cheapest available check on the change. The four route callers here instead
 * stamp `basis`/`basisNote`/`withheldPoints` onto `meta` on **every** response,
 * comparable ones included — so a comparable response's data array does not
 * move while its `meta` gains three keys. `routes/forecast.ts` carries the
 * reason: this response is one series rather than 272 entries, so naming the
 * verdict always costs nothing, and a consumer reading `basis` is then never
 * left to distinguish "comparable" from "this build predates the rule" — which
 * is a live distinction here, since the two deployed environments do run
 * different builds and the ops page tracks the drift.
 *
 * Note what `'comparable'` means on the wire, because the word is friendlier
 * than the claim: it is the registry reporting **no finding**, exactly as
 * `classifyLoadForecastBasis` documents, and never that the pair has been
 * examined and cleared. Nothing has been probed upstream except NL.
 */
export function withholdDivergentBasisSeries<T>(
  countryCode: string,
  forecastType: string,
  rows: T[],
): WithheldForecastSeries<T> {
  const verdict = classifyForecastSeriesBasis(countryCode, forecastType);
  if (verdict.basis === 'comparable') {
    return { data: rows, ...verdict, withheldPoints: 0 };
  }
  return { data: [], ...verdict, withheldPoints: rows.length };
}

/**
 * Blank every measure the pair cannot support, and nothing else.
 *
 * Driven off `ERROR_MEASURES` rather than a literal per call site, and only
 * for keys the carrier actually has — so a shape that never published `bias`
 * does not acquire a `bias: null`, and the two callers above stay honest about
 * two different response shapes without either one listing fields.
 */
function blankDerivedMeasures<T extends SuppressibleLoadMetrics>(metrics: T): T {
  const blanked = { ...metrics } as Record<string, unknown>;
  for (const measure of ERROR_MEASURES) {
    if (measure in blanked) blanked[measure] = null;
  }
  const skill = blanked.skillVsSeasonalNaive as SuppressibleSkill | undefined;
  if (skill) blanked.skillVsSeasonalNaive = { ...skill, skillPct: null };
  return blanked as T;
}
