import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDashboardStore } from '@/store/dashboardStore';
import { useCountries } from '@/hooks/useCountries';
import { useTrailingAccuracySummary, getDateRangeForPreset } from '@/hooks/useDashboardData';
import { useLoadChartData } from '@/hooks/useLoadChartData';
import { fetchTSOLoadForecast } from '@/services/api';
import { REFRESH_INTERVALS } from '@/lib/constants';
import { Figure } from '@/components/dashboard/Figure';
import { AccuracyBadge } from '@/components/dashboard/AccuracyBadge';
import { AbleResidualStrip } from '@/components/charts/AbleResidualStrip';
import { buildResidualSeries, type SeriesPoint } from '@/components/dashboard/residualSeries';
import { LoadTab } from '@/components/dashboard/LoadTab';

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
 * The country page as a scrolling annotated document.
 *
 * Figure 1 only, for now. This exists to answer one question before the rest is
 * built: does a captioned figure carrying its own accuracy claim hold up
 * against real quarter-hourly data at laptop width, on an API that serialises
 * requests? See docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md.
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

  // Same window LoadTab's chart is drawn over. The residual strip is a
  // separate claim from the badge above (which is fixed at 30 days) — this one
  // tracks whatever the page currently shows, same as the plot it annotates.
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
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
            domain={{ start: hourBucket(start.toISOString()), end: hourBucket(end.toISOString()) }}
          />
        </Figure>
      </div>
    </div>
  );
}
