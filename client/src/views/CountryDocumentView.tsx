import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDashboardStore } from '@/store/dashboardStore';
import { useCountries } from '@/hooks/useCountries';
import { useTrailingAccuracySummary, getDateRangeForPreset, useGenerationMix } from '@/hooks/useDashboardData';
import { useLoadChartData } from '@/hooks/useLoadChartData';
import { usePriceChartData } from '@/hooks/usePriceChartData';
import { useWindChartData } from '@/hooks/useWindChartData';
import {
  fetchTSOLoadForecast,
  fetchForecastData,
  fetchTSOGenerationForecast,
} from '@/services/api';
import { REFRESH_INTERVALS } from '@/lib/constants';
import { Figure } from '@/components/dashboard/Figure';
import { AccuracyBadge } from '@/components/dashboard/AccuracyBadge';
import { AbleResidualStrip } from '@/components/charts/AbleResidualStrip';
import { buildResidualSeries, type SeriesPoint } from '@/components/dashboard/residualSeries';
import { LoadTab } from '@/components/dashboard/LoadTab';
import { PriceTab } from '@/components/dashboard/PriceTab';
import { GenerationTab } from '@/components/dashboard/GenerationTab';
import { WindTab } from '@/components/dashboard/WindTab';
import { NetPositionTab } from '@/components/dashboard/NetPositionTab';

/** Pluck a usable timestamp string out of any record shape we deal with. */
function tsOf(p: { timestamp?: string; date?: string }): string | null {
  return p.timestamp ?? p.date ?? null;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * `energy_load.timestamp_utc` is genuinely UTC but is serialised without a
 * 'Z' or offset (`REPLACE(timestamp_utc, ' ', 'T')`, `loadService.ts`), while
 * the TSO forecast endpoint's timestamps carry one. A bare `new Date(...)` on
 * the former is parsed as *local* time — silently wrong by the browser's UTC
 * offset (2h in `Europe/Brussels` in August) — so both sides are forced to a
 * UTC reading before bucketing. `chartAdapters.ts`'s `hourKey()` has this same
 * gap on the actual side; that shared helper is unchanged here and out of
 * scope for this figure — this normalizes only the two series this view
 * itself fetches, so the residual strip does not go straight to zero pairs.
 */
export function asUtc(ts: string): string {
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : `${ts}Z`;
}

/** Bucket a timestamp to its hour boundary, as a canonical ISO key. Actual
 * load is quarter-hourly and the day-ahead forecast is hourly; the last
 * actual value observed in an hour wins, mirroring `buildSeriesGrid`'s own
 * bucketing (`chartAdapters.ts`). */
export function hourBucket(ts: string): string {
  const ms = Math.floor(new Date(asUtc(ts)).getTime() / HOUR_MS) * HOUR_MS;
  return new Date(ms).toISOString();
}

/**
 * Bucket any timestamped series to the hour, keeping the last value seen per
 * hour — the same rule figure 1's own (hand-rolled, unchanged) residual
 * computation follows. Shared by figures 2/4/5 below rather than copied a
 * third and fourth time; figure 1's original inline version is left exactly
 * as Task 7a shipped and verified it, rather than retrofitted onto this to
 * avoid re-touching already-reviewed code for a cosmetic gain.
 */
function bucketHourly<T>(
  points: T[] | undefined,
  pointTs: (p: T) => string | null | undefined,
  pointValue: (p: T) => number | null | undefined,
): SeriesPoint[] {
  const byHour = new Map<string, number>();
  for (const p of points ?? []) {
    const t = pointTs(p);
    const v = pointValue(p);
    if (t && v != null && Number.isFinite(v)) byHour.set(hourBucket(t), v);
  }
  return [...byHour].map(([t, v]) => ({ t, v }));
}

/**
 * The country page as a scrolling annotated document.
 *
 * Six figures: load (Task 7a), price, generation mix, onshore wind, offshore
 * wind, net position. See
 * docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md
 * for the design this implements, including the generation figure's
 * coverage-gated badge (`solarCoverageConsistent` below).
 */
export function CountryDocumentView() {
  const { selectedCountry } = useDashboardStore();
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  const { data: countries } = useCountries();
  // 30 days fixed — see useTrailingAccuracySummary. The badge's window label
  // below must match this number; they are one claim in two places.
  const { data: accuracy } = useTrailingAccuracySummary(30);

  const country = countries?.find((c) => c.country_code === selectedCountry);
  const loadMetrics = accuracy?.load?.tso?.dayAhead;

  // Same window every figure's chart is drawn over. Each residual strip is a
  // separate claim from the badges above (fixed at 30 days) — these track
  // whatever the page currently shows, same as the plot each one annotates.
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const domain = { start: hourBucket(start.toISOString()), end: hourBucket(end.toISOString()) };

  const chartData = useLoadChartData();

  // The residual strip is specifically actual vs. the TSO *day-ahead* forecast
  // — the same series the badge above quotes WAPE for ("Forecast is the
  // TSO's own day-ahead publication" below). Fetched directly here rather than
  // read off `chartData.tsoForecastData`, which only populates when the
  // (hidden, on this view) model picker has a TSO horizon selected.
  //
  // Keyed on `timePreset`/`timeOffset`, NOT on `start`/`end` themselves:
  // `getDateRangeForPreset` calls `new Date()` internally, so the Date objects
  // above are fresh every render — a key built from their `.toISOString()`
  // would differ by milliseconds each render and refetch without end against
  // an API that serialises (`useLoadChartData`'s own tso-forecast query keys
  // the same way, `useLoadChartData.ts`).
  const { data: dayAheadForecast } = useQuery({
    queryKey: ['tso-forecast', 'load', selectedCountry, 'day_ahead', timePreset, timeOffset],
    queryFn: () =>
      fetchTSOLoadForecast({
        countryCode: selectedCountry,
        start: start.toISOString(),
        end: end.toISOString(),
        forecastType: 'day_ahead',
      }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });

  const residuals = useMemo(() => {
    // Bucket both series to the hour before pairing — see `hourBucket` above.
    // Last value per hour wins on the actual (quarter-hourly) side.
    const actualByHour = new Map<string, number>();
    for (const p of chartData.loadData ?? []) {
      const ts = tsOf(p);
      const v = p.load ?? p.avg_load ?? null;
      if (ts && v != null && Number.isFinite(v)) actualByHour.set(hourBucket(ts), v);
    }
    const forecastByHour = new Map<string, number>();
    for (const p of dayAheadForecast?.points ?? []) {
      if (p.timestamp && Number.isFinite(p.forecast_value_mw)) {
        forecastByHour.set(hourBucket(p.timestamp), p.forecast_value_mw);
      }
    }
    const actual: SeriesPoint[] = [...actualByHour].map(([t, v]) => ({ t, v }));
    const forecast: SeriesPoint[] = [...forecastByHour].map(([t, v]) => ({ t, v }));
    return buildResidualSeries(actual, forecast);
  }, [chartData.loadData, dayAheadForecast]);

  // --- Figure 2: price -------------------------------------------------
  //
  // ENTSO-E does not publish a day-ahead price forecast — `usePriceChartData`
  // says so in its own doc comment ("PriceChart doesn't have TSO forecasts")
  // and `forecastComparisonService.ts`'s `TSO_FORECAST_TYPES` omits `price`
  // entirely, so `accuracy.price.tso` is always `{}` and `.dayAhead` is
  // always `undefined`. The measurable accuracy for this figure is able-ml's
  // own D+1 forecast instead.
  const priceMetrics = accuracy?.price?.ml?.d1;
  const priceChartData = usePriceChartData();
  // Fetched directly here for the same reason the load figure fetches its own
  // TSO forecast above: `priceChartData.forecastData`'s query is `enabled:
  // showForecast`, gated on the (hidden, on this view) picker's resolved
  // selection, and this residual needs the series regardless of that state.
  const { data: priceForecast } = useQuery({
    queryKey: ['forecast', 'doc', 'price', selectedCountry, timePreset, timeOffset],
    queryFn: () =>
      fetchForecastData({
        country: selectedCountry,
        type: 'price',
        start: start.toISOString(),
        end: end.toISOString(),
      }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });
  const priceResiduals = useMemo(
    () =>
      buildResidualSeries(
        bucketHourly(priceChartData.priceData, (p) => p.timestamp, (p) => p.price),
        bucketHourly(priceForecast?.points, (p) => p.timestamp, (p) => p.value),
      ),
    [priceChartData.priceData, priceForecast],
  );

  // --- Figure 3: generation mix — coverage-gated solar badge ------------
  //
  // `loadForecastBasis.ts` covers load only; the generation-side counterpart
  // is ABL-400 and is still open. Ungated, a country whose reported solar is
  // only a grid-metered subset of its fleet (NL) would show a green check
  // beside a WAPE the server's own comment calls "arithmetically correct and
  // still not an accuracy figure" (`tsoForecastService.ts`). Gating on
  // `solarCoverage.ts`'s verdict — already computed server-side and already
  // riding on this same generation-mix payload — costs a lookup, not a
  // reimplementation of ABL-400's work.
  const { data: mix } = useGenerationMix();
  const solarMetrics = accuracy?.solar?.tso?.dayAhead;
  // A missing `solar_coverage` (older server) reads identically to `unknown`
  // — the type's own doc comment requires it, and `undefined === 'consistent'`
  // is `false` regardless, so no extra branch is needed to get that for free.
  const solarCoverageConsistent = mix?.solar_coverage?.verdict === 'consistent';

  // --- Figures 4 & 5: onshore / offshore wind ---------------------------
  //
  // Two figures, not one: `wind_onshore` and `wind_offshore` are separate
  // registered forecast types with separate accuracy figures, so each gets
  // its own honest badge rather than one figure picking between two. No
  // coverage gate here — there is no wind counterpart to `solarCoverage.ts`,
  // so the badge renders on the grounds that nothing has been measured, a
  // weaker claim than verified (spec: "Wind is unevidenced, not verified").
  const onshoreMetrics = accuracy?.wind_onshore?.tso?.dayAhead;
  const offshoreMetrics = accuracy?.wind_offshore?.tso?.dayAhead;
  const onshoreChartData = useWindChartData('wind_onshore');
  const offshoreChartData = useWindChartData('wind_offshore');
  // One bundled fetch covers both types (`fetchTSOGenerationForecast`'s own
  // doc comment: "the wind tab's TSO_D1 branch picks its own column out"), so
  // one dedicated query serves both residual strips below rather than two.
  const { data: windForecast } = useQuery({
    queryKey: ['tso-forecast', 'generation', 'doc', selectedCountry, timePreset, timeOffset],
    queryFn: () =>
      fetchTSOGenerationForecast({
        countryCode: selectedCountry,
        start: start.toISOString(),
        end: end.toISOString(),
      }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });
  const onshoreResiduals = useMemo(
    () =>
      buildResidualSeries(
        bucketHourly(onshoreChartData.windData, (p) => p.timestamp, (p) => p.wind_onshore),
        bucketHourly(windForecast, (p) => p.timestamp, (p) => p.wind_onshore_mw),
      ),
    [onshoreChartData.windData, windForecast],
  );
  const offshoreResiduals = useMemo(
    () =>
      buildResidualSeries(
        bucketHourly(offshoreChartData.windData, (p) => p.timestamp, (p) => p.wind_offshore),
        bucketHourly(windForecast, (p) => p.timestamp, (p) => p.wind_offshore_mw),
      ),
    [offshoreChartData.windData, windForecast],
  );

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="mx-auto max-w-[1200px] px-5 pb-14 pt-6 md:px-8">
        <h1 className="m-0 mb-2 text-display font-medium">
          {country?.country_name ?? selectedCountry}
        </h1>
        <p className="mb-6 max-w-[76ch] text-body text-ink-dim [text-wrap:pretty]">
          Load, price, generation and cross-border position — each shown against
          the forecast that was published before the fact.
        </p>

        <Figure
          number={1}
          anchorId="load"
          title="Electricity demand against its day-ahead forecast"
          caption="System load in quarter-hourly resolution, drawn against the day-ahead
                   forecast published the previous morning. The separation between the two
                   lines is the subject of this page."
          footnote={
            <>
              <AccuracyBadge metrics={loadMetrics} window="30 days" />
              <span>
                Forecast is the TSO&rsquo;s own day-ahead publication, not an able model.
              </span>
            </>
          }
        >
          <LoadTab variant="figure" />
          <AbleResidualStrip
            points={residuals}
            unit="MW"
            // Hour-aligned so it lands exactly on the same grid `hourBucket`
            // built `residuals` on. Not read off LoadTab's own chart — that
            // plot is a black box from here by design (Problem 1) and its
            // domain shifts with whichever forecast source is active. This
            // window is what `dayAheadForecast` above was fetched over, so
            // no residual bar can fall outside it; for the common
            // `timePreset === 'today'` case it is also exactly what LoadTab's
            // own chart draws.
            domain={domain}
          />
        </Figure>

        <Figure
          number={2}
          anchorId="price"
          title="Day-ahead price against its forecast"
          caption="The EPEX day-ahead auction clearing price, drawn against able's own
                   machine-learning forecast for the same hours."
          footnote={
            <>
              <AccuracyBadge metrics={priceMetrics} window="30 days" />
              <span>
                Forecast is able-ml&rsquo;s own day-ahead model — ENTSO-E does not publish a
                price forecast.
              </span>
            </>
          }
        >
          <PriceTab variant="figure" />
          <AbleResidualStrip points={priceResiduals} unit="€/MWh" domain={domain} />
        </Figure>

        <Figure
          number={3}
          anchorId="generation"
          title="Generation mix by source"
          caption="Hourly generation stacked by source, from ENTSO-E's full A75 document —
                   nuclear and fossil bands included, not only the renewable families."
          footnote={
            <>
              {/* Coverage-gated: the badge itself has no way to know its own
                  denominator is invalid, so the gate has to sit outside it —
                  see `solarCoverageConsistent` above. */}
              {solarCoverageConsistent && <AccuracyBadge metrics={solarMetrics} window="30 days" />}
              <span>
                {solarCoverageConsistent
                  ? 'Badge reports the solar component of generation only — no forecast is published for the mix as a whole.'
                  : 'Solar accuracy withheld here — the day-ahead forecast and the metered actuals describe different populations, so no accuracy figure is meaningful.'}
              </span>
            </>
          }
        >
          <GenerationTab variant="figure" />
        </Figure>

        <Figure
          number={4}
          anchorId="wind-onshore"
          title="Onshore wind generation against its forecast"
          caption="Onshore wind output, drawn against ENTSO-E's own day-ahead generation
                   forecast for the same hours."
          footnote={
            <>
              <AccuracyBadge metrics={onshoreMetrics} window="30 days" />
              <span>
                Forecast is the TSO&rsquo;s own day-ahead publication, not an able model.
              </span>
            </>
          }
        >
          <WindTab windType="wind_onshore" variant="figure" />
          <AbleResidualStrip points={onshoreResiduals} unit="MW" domain={domain} />
        </Figure>

        <Figure
          number={5}
          anchorId="wind-offshore"
          title="Offshore wind generation against its forecast"
          caption="Offshore wind output, drawn against ENTSO-E's own day-ahead generation
                   forecast for the same hours."
          footnote={
            <>
              <AccuracyBadge metrics={offshoreMetrics} window="30 days" />
              <span>
                Forecast is the TSO&rsquo;s own day-ahead publication, not an able model.
              </span>
            </>
          }
        >
          <WindTab windType="wind_offshore" variant="figure" />
          <AbleResidualStrip points={offshoreResiduals} unit="MW" domain={domain} />
        </Figure>

        <Figure
          number={6}
          anchorId="net-position"
          title="Net cross-border position"
          caption="Net export (positive) or import (negative) position at the border,
                   by hour."
          footnote={
            <>
              {/* No forecast type exists for net position — `metrics={undefined}`
                  resolves to AccuracyBadge's own `absent` state, so this
                  intentionally renders nothing beside the prose. */}
              <AccuracyBadge metrics={undefined} window="30 days" />
              <span>No forecast is published for net position — this figure shows the settled position only.</span>
            </>
          }
        >
          <NetPositionTab variant="figure" />
        </Figure>
      </div>
    </div>
  );
}
