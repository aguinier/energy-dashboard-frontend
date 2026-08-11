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

export function NetPositionTab() {
  const result = useNetPositionData();
  const { data: countries } = useCountries();
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const country = countries?.find((c) => c.country_code === selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);
  const countryLabel = country?.country_name ?? selectedCountry;

  // Only meaningful for the transform below and the degenerate-forecast note
  // — `resolveMultiSelection` already collapses "hidden" to an empty
  // selection, which is why `result.mode` alone doesn't need a third state.
  const { hidden: forecastHidden } = useMultiModelSelection('net_position');

  if (result.mode === 'default') {
    return (
      <NetPositionDefaultView
        data={result.data}
        isLoading={result.isLoading}
        isError={result.isError}
        forecastHidden={forecastHidden}
        countryLabel={countryLabel}
        timePreset={timePreset}
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
}: {
  data: NetPositionResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  forecastHidden: boolean;
  countryLabel: string;
  timePreset: string;
}) {
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

  return (
    <div className="space-y-3.5">
      <AbleCard title="Net position" subtitle={subtitleParts.join(' · ')}>
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
}: {
  entries: NetPositionModelQuery[];
  isLoading: boolean;
  isError: boolean;
  countryLabel: string;
  timePreset: string;
}) {
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

  return (
    <div className="space-y-3.5">
      <AbleCard title="Net position" subtitle={subtitleParts.join(' · ')}>
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
