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
 */
export const DIVERGENT_LOAD_BASIS: Readonly<Record<string, DivergentLoadBasis>> = {
  NL: {
    reason:
      'Not measurable here. ENTSO-E publishes the Dutch realized load net of ' +
      'behind-the-meter solar and the day-ahead forecast without it, so the ' +
      'difference between them is a definitional gap, not forecast error.',
    measuredOn: '2026-08-12',
  },
};

export interface LoadForecastBasisVerdict {
  basis: LoadForecastBasis;
  /** Non-null exactly when `basis` is `divergent_basis`. */
  basisNote: string | null;
}

/**
 * Classify a country's realized-vs-TSO-forecast load pair.
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

export interface SuppressibleLoadMetrics {
  mae: number | null;
  mape: number | null;
  rmse: number | null;
  dataPoints: number;
  mapeSamples: number;
}

/**
 * Blank the error measures for a divergent pair, keeping the pairing counts.
 *
 * `dataPoints`/`mapeSamples` stay truthful: they describe how many rows paired
 * up, which is real, and zeroing them would assert "no data" — a different and
 * equally false claim, the same distinction `degenerate_zero` draws against
 * `no_actuals` on the net-position side.
 */
export function applyLoadForecastBasis<T extends SuppressibleLoadMetrics>(
  countryCode: string,
  metrics: T,
): T & LoadForecastBasisVerdict {
  const verdict = classifyLoadForecastBasis(countryCode);
  if (verdict.basis === 'comparable') return { ...metrics, ...verdict };
  return { ...metrics, ...verdict, mae: null, mape: null, rmse: null };
}
