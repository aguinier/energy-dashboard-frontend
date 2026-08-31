import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { AbleLineChart } from '@/components/charts/AbleLineChart';
import { useNetPositionData } from '@/hooks/useNetPositionData';
import type { NetPositionModelQuery } from '@/hooks/useNetPositionData';
import { useCountries } from '@/hooks/useCountries';
import { useDashboardStore } from '@/store/dashboardStore';
import { adaptNetPositionSeries, adaptNetPositionMultiSeries } from '@/lib/chartAdapters';
import type { NetPositionModelSeriesInput } from '@/lib/chartAdapters';
import { summarizeVintages, capVintages } from '@/lib/netPositionProvenance';
import { useMultiModelSelection } from '@/hooks/useForecastModels';
import { describeForecastGap } from '@/lib/forecastGap';
import { describeDegenerateActual, describeDegenerateForecast } from './degenerateForecastNote';
import type { NetPositionResponse } from '@/types';
import { netPositionTabDisclosure } from '@/lib/netPositionScope';
import { useCoreNetPositionData } from '@/hooks/useCoreNetPositionData';
import { adaptCoreNetPositionSeries } from '@/lib/coreNetPositionSeries';
import { describeCoreCoverage } from './coreNetPositionNote';

/** Countries whose net position is folded into a multi-country bidding zone. */
const SHARED_ZONE_NOTE: Record<string, string> = {
  DE_LU: 'DE_LU is one bidding zone — this series covers Germany and Luxembourg together.',
};

function formatMw(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return `${(v / 1000).toFixed(2)} GW`;
  return `${v.toFixed(0)} MW`;
}

function formatAxis(v: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toFixed(0);
}

/** The entry whose `actual` rows to trust when several model responses are on screen — every entry carries the same actuals for a given country/window, since the model pin only ever changes the forecast half. */
function pickActualSource(entries: NetPositionModelQuery[]): NetPositionResponse | undefined {
  return entries.find((e) => (e.data?.actual.length ?? 0) > 0)?.data ?? entries[0]?.data;
}

/** One footnote per selected model that came back with no forecast rows for this window — named rather than silently absent from the chart (ABL-203 acceptance: "honest empty states"). */
function forecastFootnotes(
  entries: NetPositionModelQuery[],
  countryLabel: string,
): Array<{ id: string; color: string; headline: string; detail?: string }> {
  const notes: Array<{ id: string; color: string; headline: string; detail?: string }> = [];
  for (const entry of entries) {
    if (entry.isLoading || !entry.data) continue;
    if (entry.data.forecast.length > 0) continue;

    if (entry.data.meta.forecast_coverage === 'degenerate_zero') {
      const note = describeDegenerateForecast(entry.data.meta, countryLabel);
      if (note) notes.push({ id: entry.id, color: entry.color, headline: note.headline, detail: note.detail });
      continue;
    }

    const gap = describeForecastGap({
      active: true,
      pinnedLabel: entry.label,
      isLoading: false,
      isError: entry.isError,
      pointCount: 0,
      countryLabel,
    });
    if (gap) notes.push({ id: entry.id, color: entry.color, headline: gap.message });
  }
  return notes;
}

export interface NetPositionTabProps {
  /**
   * 'tab' (default) was the tab view's body (`CountryDashboardView.tsx`,
   * deleted in Task 9b): the `AbleCard` carries its own title/subtitle.
   * 'figure' is the country document's plot slot
   * (docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md):
   * one plot per figure, so the `AbleCard` gets no header of its own — the
   * figure supplies the number, title and caption instead. See
   * `LoadTab.tsx`'s identical prop for the full rationale, including why
   * 'tab' stays the default with no production caller left. Threaded through
   * all three render paths — default, selection and Core — since the scope
   * toggle and the model picker both stay live in the figure.
   */
  variant?: 'tab' | 'figure';
}

export function NetPositionTab({ variant = 'tab' }: NetPositionTabProps = {}) {
  const result = useNetPositionData();
  const { data: countries } = useCountries();
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const country = countries?.find((c) => c.country_code === selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);
  const scope = useDashboardStore((s) => s.netPositionScope);
  const countryLabel = country?.country_name ?? selectedCountry;

  // Only meaningful for the transform below and the degenerate-forecast note
  // — `resolveMultiSelection` already collapses "hidden" to an empty
  // selection, which is why `result.mode` alone doesn't need a third state.
  const { hidden: forecastHidden } = useMultiModelSelection('net_position');
  const scopeDisclosure = useMemo(
    () => netPositionTabDisclosure(selectedCountry, scope),
    [selectedCountry, scope],
  );

  // Core is its own view rather than a third `mode` on `useNetPositionData`:
  // it is a different quantity from a different table with no forecast half
  // at all, and the model picker's whole selection vocabulary is meaningless
  // for it. Hooks above are called unconditionally, so this early return
  // cannot change hook order.
  if (scope === 'core') {
    return (
      <CoreNetPositionView
        countryLabel={countryLabel}
        timePreset={timePreset}
        scopeDisclosure={scopeDisclosure}
        variant={variant}
      />
    );
  }

  if (result.mode === 'default') {
    return (
      <NetPositionDefaultView
        data={result.data}
        isLoading={result.isLoading}
        isError={result.isError}
        forecastHidden={forecastHidden}
        countryLabel={countryLabel}
        timePreset={timePreset}
        scopeDisclosure={scopeDisclosure}
        variant={variant}
      />
    );
  }

  return (
    <NetPositionSelectionView
      entries={result.entries}
      isLoading={result.isLoading}
      isError={result.isError}
      countryLabel={countryLabel}
      timePreset={timePreset}
      scopeDisclosure={scopeDisclosure}
      variant={variant}
    />
  );
}

/**
 * "Default" — nothing checked in the picker, so the server's candidate ladder
 * serves. Unchanged from before ABL-203: this is exactly the single-model
 * behaviour every returning user (and every earlier ticket's fix) already
 * relies on, so it stays its own path rather than routing through the
 * multi-model machinery with one synthetic entry.
 */
function NetPositionDefaultView({
  data,
  isLoading,
  isError,
  forecastHidden,
  countryLabel,
  timePreset,
  scopeDisclosure,
  variant,
}: {
  data: NetPositionResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  forecastHidden: boolean;
  countryLabel: string;
  timePreset: string;
  scopeDisclosure: string;
  variant: 'tab' | 'figure';
}) {
  const isFigure = variant === 'figure';
  const shown = useMemo(
    () => (forecastHidden && data ? { ...data, forecast: [] } : data),
    [data, forecastHidden],
  );

  const { series, nowIndex } = useMemo(() => adaptNetPositionSeries(shown), [shown]);

  // Several forecast runs can be on screen at once (see netPositionService's
  // freshest-per-timestamp read), so provenance is a list, not a single
  // generated_at - a subtitle claiming one generation time for the whole
  // series would be wrong the moment two vintages are both showing.
  const vintages = useMemo(() => summarizeVintages(data?.meta.vintages), [data]);

  // One run lands per day and the window keeps every run whose target day it
  // covers, so a wide preset would otherwise stack ~33 rows under the chart.
  const { shown: shownVintages, hiddenCount: hiddenVintageCount } = useMemo(
    () => capVintages(vintages),
    [vintages],
  );

  const latest = useMemo(() => {
    const withValue = (data?.actual ?? []).filter((p) => p.net_position_mw != null);
    return withValue.length ? withValue[withValue.length - 1] : null;
  }, [data]);

  const zoneNote = data ? SHARED_ZONE_NOTE[data.meta.bidding_zone] : undefined;

  // The server withholds a forecast series that is numerically zero rather
  // than letting it draw as a flat, confident-looking line at 0 MW (ABL-25,
  // GR). It must not become a silent gap here: the reason renders in both the
  // charted and the empty state, and only when the user has not switched the
  // forecast off themselves.
  const degenerateNote = useMemo(
    () => (forecastHidden ? null : describeDegenerateForecast(data?.meta, countryLabel)),
    [data, forecastHidden, countryLabel],
  );

  // The actuals get the same treatment, and it is the more serious of the two:
  // a withheld forecast costs a prediction, a withheld actual is a measurement
  // we were stating as fact (ABL-35, GR's exact zeros since 2025-10-01). Not
  // gated on the picker - that switches the forecast off, never the actuals.
  const degenerateActualNote = useMemo(
    () => describeDegenerateActual(data?.meta, countryLabel),
    [data, countryLabel],
  );

  // A zone that stopped publishing is a data gap, not a loading state. The
  // date has to come from meta.last_seen rather than the returned points: a
  // zone can have gone silent long before any window the user can pick, so the
  // rows themselves can never name the date.
  const lastSeen = data?.meta.last_seen ? new Date(data.meta.last_seen) : null;
  const hasNothing = !isLoading && (data?.actual.length ?? 0) === 0;
  const isStale =
    !isLoading &&
    lastSeen != null &&
    Date.now() - lastSeen.getTime() > 7 * 24 * 60 * 60 * 1000;

  const subtitleParts = [
    'MW · positive = exporter',
    countryLabel,
    'ENTSO-E day-ahead',
  ];
  if (!forecastHidden && vintages.length === 1) {
    // Exactly one run on screen - safe to name its generation time here,
    // same as before this change.
    const v = vintages[0];
    subtitleParts.push(
      `forecast ${data?.meta.model_name ?? 'model'} · ${v.dayLabel} · generated ${new Date(
        v.generated_at,
      ).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
    );
  } else if (!forecastHidden && vintages.length > 1) {
    // Several runs, each covering its own target window - naming one
    // generation time here would misattribute it to the whole chart. The
    // per-run breakdown renders as its own row below, and each point's
    // tooltip carries its own vintage besides.
    subtitleParts.push(
      `forecast ${data?.meta.model_name ?? 'model'} · ${vintages.length} runs on screen`,
    );
  }

  const meta = subtitleParts.join(' · ');

  return (
    <div className="space-y-3.5">
      <AbleCard title={isFigure ? undefined : 'Net position'} subtitle={isFigure ? undefined : meta}>
        <p className="mb-2.5 text-micro text-ink-muted">{scopeDisclosure}</p>
        {isLoading ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Loading…
          </div>
        ) : isError ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Could not load net position.
          </div>
        ) : hasNothing ? (
          <div className="flex h-[300px] flex-col items-center justify-center gap-1 text-center text-meta text-ink-muted">
            {degenerateActualNote ? (
              // Takes precedence over "stopped publishing": ENTSO-E is still
              // returning rows for this zone, so blaming an ended series would
              // be the wrong story told confidently. What ended is the data
              // inside the rows.
              <>
                <span>{degenerateActualNote.headline}</span>
                <span className="max-w-md text-micro text-ink-muted">
                  {degenerateActualNote.detail}
                </span>
                {lastSeen && (
                  <span className="text-micro text-ink-muted">
                    Last usable hour:{' '}
                    {lastSeen.toLocaleDateString([], {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                    .
                  </span>
                )}
              </>
            ) : lastSeen ? (
              <>
                <span>
                  {countryLabel} stopped publishing a net position on{' '}
                  {lastSeen.toLocaleDateString([], {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                  .
                </span>
                <span className="text-micro text-ink-muted">
                  The series ended upstream at ENTSO-E, not here.
                </span>
              </>
            ) : (
              <>
                <span>No net position published for {countryLabel}.</span>
                <span className="text-micro text-ink-muted">
                  Not every bidding zone publishes one.
                </span>
              </>
            )}
          </div>
        ) : (
          <>
            <AbleLineChart
              series={series}
              nowIndex={nowIndex}
              height={300}
              formatAxis={formatAxis}
              formatTooltip={formatMw}
              preset={timePreset}
              label="Net position"
            />
            {/* In the figure composition the card carries no header, so the
                subtitle line that would otherwise live there is stated here
                instead — see LoadTab.tsx's identical treatment. */}
            {isFigure && <p className="mt-2 text-micro text-ink-muted">{meta}</p>}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-ink-muted">
              {latest && (
                <span className="font-mono-num">
                  latest {formatMw(latest.net_position_mw)}{' '}
                  <span className="text-ink-muted">
                    ({latest.net_position_mw >= 0 ? 'exporting' : 'importing'})
                  </span>
                </span>
              )}
              {!forecastHidden && data?.meta.has_band && <span>shaded band = p10–p90</span>}
              {!forecastHidden && data && !data.meta.has_band && data.forecast.length > 0 && (
                <span>median only — no uncertainty band stored</span>
              )}
            </div>
            {/* Per-run provenance. Only needed once there is more than one
                vintage on screen - a single run is already named in the
                subtitle above, so a one-row repeat here would be noise. */}
            {!forecastHidden && vintages.length > 1 && (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-muted">
                {shownVintages.map((v) => (
                  <span key={v.generated_at} className="font-mono-num">
                    {v.dayLabel} run generated{' '}
                    {new Date(v.generated_at).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    ({v.target_count} pts)
                  </span>
                ))}
                {hiddenVintageCount > 0 && (
                  <span className="font-mono-num">
                    +{hiddenVintageCount} older{' '}
                    {hiddenVintageCount === 1 ? 'run' : 'runs'}
                  </span>
                )}
              </div>
            )}
          </>
        )}

        {/* Outside the branch above on purpose: GR has both problems at once
            (no actuals in most windows AND a zero forecast), so this has to
            render beside the "stopped publishing" empty state as well as
            under a chart that still draws actuals. */}
        {degenerateNote && (
          <p className="mt-2 text-micro text-ink-muted">
            <span className="text-ink-dim">{degenerateNote.headline}</span>{' '}
            {degenerateNote.detail}
          </p>
        )}

        {/* Only as a footnote under a chart that still has points; the empty
            state above already says it when there is nothing to draw. */}
        {isStale && lastSeen && !hasNothing && (
          <p className="mt-2 text-micro text-ink-muted">
            No data published since{' '}
            {lastSeen.toLocaleDateString([], {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
            . The series has stopped upstream, not here.
          </p>
        )}

        {zoneNote && <p className="mt-2 text-micro text-ink-muted">{zoneNote}</p>}
      </AbleCard>
    </div>
  );
}

/**
 * Core region only — the JAO Core CCR net position (ABL-234).
 *
 * Actuals only, and that is a fact about the data rather than a simplification:
 * nothing in this dashboard forecasts the Core figure. The registry has no
 * `core_net_position` forecast type and no model produces one, so there is no
 * dashed line to draw and no picker selection that could add one. The card
 * says so rather than leaving a reader to wonder why their checked models
 * stopped appearing — an unexplained absence is the same defect class as a
 * confident wrong value, one level quieter.
 */
function CoreNetPositionView({
  countryLabel,
  timePreset,
  scopeDisclosure,
  variant,
}: {
  countryLabel: string;
  timePreset: string;
  scopeDisclosure: string;
  variant: 'tab' | 'figure';
}) {
  const isFigure = variant === 'figure';
  const { data, isLoading, isError } = useCoreNetPositionData();

  const { series, nowIndex, maxIntervalsPerHour } = useMemo(
    () => adaptCoreNetPositionSeries(data),
    [data],
  );

  const coverageNote = useMemo(
    () => describeCoreCoverage(data?.meta, countryLabel),
    [data, countryLabel],
  );

  const latest = useMemo(() => {
    const withValue = series.filter((p) => p.value != null);
    return withValue.length ? withValue[withValue.length - 1] : null;
  }, [series]);

  const lastSeen = data?.meta.last_seen ? new Date(data.meta.last_seen) : null;
  const hasNothing = !isLoading && series.length === 0;

  const subtitleParts = ['MW · positive = exporter', countryLabel, 'JAO Core CCR'];
  // Only claimed once the data proves it: JAO publishes at 15 minutes and this
  // chart is an hourly mean of those intervals, so saying so is the difference
  // between an average and a reading. `1` means the stored rows were already
  // hourly, and averaging four of nothing is not a claim worth making.
  if (maxIntervalsPerHour > 1) {
    subtitleParts.push(`hourly mean of ${maxIntervalsPerHour} published intervals`);
  }

  const meta = subtitleParts.join(' · ');

  return (
    <div className="space-y-3.5">
      <AbleCard title={isFigure ? undefined : 'Net position'} subtitle={isFigure ? undefined : meta}>
        <p className="mb-2.5 text-micro text-ink-muted">{scopeDisclosure}</p>
        {isLoading ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Loading…
          </div>
        ) : isError ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Could not load Core net position.
          </div>
        ) : hasNothing ? (
          <div className="flex h-[300px] flex-col items-center justify-center gap-1 text-center text-meta text-ink-muted">
            {coverageNote ? (
              <>
                <span>{coverageNote.headline}</span>
                <span className="max-w-md text-micro text-ink-muted">{coverageNote.detail}</span>
                {/* Only for a zone that has published before — it dates the
                    gap. Absent for `out_of_core`/`not_captured`, where there
                    is no such date and printing one would imply the series
                    had ended. */}
                {lastSeen && data?.meta.coverage === 'no_data' && (
                  <span className="text-micro text-ink-muted">
                    Last stored hour:{' '}
                    {lastSeen.toLocaleDateString([], {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                    .
                  </span>
                )}
              </>
            ) : (
              <span>No Core net position for {countryLabel} in this window.</span>
            )}
          </div>
        ) : (
          <>
            <AbleLineChart
              series={series}
              nowIndex={nowIndex}
              height={300}
              formatAxis={formatAxis}
              formatTooltip={formatMw}
              preset={timePreset}
              label="Core net position"
            />
            {/* In the figure composition the card carries no header, so the
                subtitle line that would otherwise live there is stated here
                instead — see LoadTab.tsx's identical treatment. */}
            {isFigure && <p className="mt-2 text-micro text-ink-muted">{meta}</p>}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-ink-muted">
              {latest?.value != null && (
                <span className="font-mono-num">
                  latest {formatMw(latest.value)}{' '}
                  <span className="text-ink-muted">
                    ({latest.value >= 0 ? 'exporting' : 'importing'})
                  </span>
                </span>
              )}
              <span>no forecast — the Core figure is published, not modelled here</span>
            </div>
          </>
        )}
      </AbleCard>
    </div>
  );
}

/**
 * One or more models explicitly checked in the picker. Every entry is its own
 * request, pinned to its own model id (ABL-177's property, now fanned out —
 * see useNetPositionData), so a model with no coverage for this country comes
 * back empty rather than borrowing another model's rows.
 */
function NetPositionSelectionView({
  entries,
  isLoading,
  isError,
  countryLabel,
  timePreset,
  scopeDisclosure,
  variant,
}: {
  entries: NetPositionModelQuery[];
  isLoading: boolean;
  isError: boolean;
  countryLabel: string;
  timePreset: string;
  scopeDisclosure: string;
  variant: 'tab' | 'figure';
}) {
  const isFigure = variant === 'figure';
  const seriesInputs: NetPositionModelSeriesInput[] = useMemo(
    () => entries.map((e) => ({ id: e.id, label: e.label, color: e.color, response: e.data })),
    [entries],
  );

  const { series, nowIndex, forecastSeries } = useMemo(
    () => adaptNetPositionMultiSeries(seriesInputs),
    [seriesInputs],
  );

  const actualSource = useMemo(() => pickActualSource(entries), [entries]);

  const latest = useMemo(() => {
    const withValue = (actualSource?.actual ?? []).filter((p) => p.net_position_mw != null);
    return withValue.length ? withValue[withValue.length - 1] : null;
  }, [actualSource]);

  const zoneNote = actualSource ? SHARED_ZONE_NOTE[actualSource.meta.bidding_zone] : undefined;
  const degenerateActualNote = useMemo(
    () => describeDegenerateActual(actualSource?.meta, countryLabel),
    [actualSource, countryLabel],
  );

  const lastSeen = actualSource?.meta.last_seen ? new Date(actualSource.meta.last_seen) : null;
  const hasNothing = !isLoading && (actualSource?.actual.length ?? 0) === 0;
  const isStale =
    !isLoading && lastSeen != null && Date.now() - lastSeen.getTime() > 7 * 24 * 60 * 60 * 1000;

  // A model with no rows for this zone is named, not silently dropped from
  // the chart — the recurring defect class this whole picker has to avoid.
  // Covers both "the model genuinely has no coverage here" and GR's
  // numerically-zero degenerate forecast, per model.
  const footnotes = useMemo(() => forecastFootnotes(entries, countryLabel), [entries, countryLabel]);

  // Exactly one model checked: name its generation run the same way the
  // Default view does, rather than just falling back to "N forecast models".
  const soleVintages = useMemo(
    () => (entries.length === 1 ? summarizeVintages(entries[0].data?.meta.vintages) : []),
    [entries],
  );

  const subtitleParts = ['MW · positive = exporter', countryLabel, 'ENTSO-E day-ahead'];
  if (forecastSeries.length === 1 && soleVintages.length >= 1) {
    const v = soleVintages[0];
    subtitleParts.push(
      soleVintages.length === 1
        ? `forecast ${forecastSeries[0].label} · ${v.dayLabel} · generated ${new Date(
            v.generated_at,
          ).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
        : `forecast ${forecastSeries[0].label} · ${soleVintages.length} runs on screen`,
    );
  } else if (forecastSeries.length > 1) {
    subtitleParts.push(`comparing ${forecastSeries.length} forecast models`);
  }

  const hasSingleBand = forecastSeries.length === 1 && series.some((p) => p.min != null && p.max != null);
  const singleNoBand =
    forecastSeries.length === 1 && !hasSingleBand && series.some((p) => p.forecast != null);

  const meta = subtitleParts.join(' · ');

  return (
    <div className="space-y-3.5">
      <AbleCard title={isFigure ? undefined : 'Net position'} subtitle={isFigure ? undefined : meta}>
        <p className="mb-2.5 text-micro text-ink-muted">{scopeDisclosure}</p>
        {isLoading ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Loading…
          </div>
        ) : isError ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Could not load net position.
          </div>
        ) : hasNothing ? (
          <div className="flex h-[300px] flex-col items-center justify-center gap-1 text-center text-meta text-ink-muted">
            {degenerateActualNote ? (
              <>
                <span>{degenerateActualNote.headline}</span>
                <span className="max-w-md text-micro text-ink-muted">{degenerateActualNote.detail}</span>
                {lastSeen && (
                  <span className="text-micro text-ink-muted">
                    Last usable hour:{' '}
                    {lastSeen.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })}.
                  </span>
                )}
              </>
            ) : lastSeen ? (
              <>
                <span>
                  {countryLabel} stopped publishing a net position on{' '}
                  {lastSeen.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })}.
                </span>
                <span className="text-micro text-ink-muted">
                  The series ended upstream at ENTSO-E, not here.
                </span>
              </>
            ) : (
              <>
                <span>No net position published for {countryLabel}.</span>
                <span className="text-micro text-ink-muted">Not every bidding zone publishes one.</span>
              </>
            )}
          </div>
        ) : (
          <>
            <AbleLineChart
              series={series}
              nowIndex={nowIndex}
              height={300}
              formatAxis={formatAxis}
              formatTooltip={formatMw}
              preset={timePreset}
              label="Net position"
              forecastSeries={forecastSeries}
            />
            {/* In the figure composition the card carries no header, so the
                subtitle line that would otherwise live there is stated here
                instead — see LoadTab.tsx's identical treatment. */}
            {isFigure && <p className="mt-2 text-micro text-ink-muted">{meta}</p>}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-ink-muted">
              {latest && (
                <span className="font-mono-num">
                  latest {formatMw(latest.net_position_mw)}{' '}
                  <span className="text-ink-muted">
                    ({latest.net_position_mw >= 0 ? 'exporting' : 'importing'})
                  </span>
                </span>
              )}
              {hasSingleBand && <span>shaded band = p10–p90</span>}
              {singleNoBand && <span>median only — no uncertainty band stored</span>}
              {forecastSeries.length > 1 && (
                <span>no band with several models on screen — check one alone for its p10–p90</span>
              )}
            </div>
          </>
        )}

        {footnotes.map((note) => (
          <p key={note.id} className="mt-2 flex items-start gap-1.5 text-micro text-ink-muted">
            <span
              aria-hidden="true"
              className="mt-0.5 h-2 w-2 shrink-0 rounded-full"
              style={{ background: note.color }}
            />
            <span>
              <span className="text-ink-dim">{note.headline}</span>
              {note.detail && <> {note.detail}</>}
            </span>
          </p>
        ))}

        {isStale && lastSeen && !hasNothing && (
          <p className="mt-2 text-micro text-ink-muted">
            No data published since{' '}
            {lastSeen.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })}. The
            series has stopped upstream, not here.
          </p>
        )}

        {zoneNote && <p className="mt-2 text-micro text-ink-muted">{zoneNote}</p>}
      </AbleCard>
    </div>
  );
}
