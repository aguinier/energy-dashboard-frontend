import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { AbleLineChart } from '@/components/charts/AbleLineChart';
import { useNetPositionData } from '@/hooks/useNetPositionData';
import { useCountries } from '@/hooks/useCountries';
import { useDashboardStore } from '@/store/dashboardStore';
import { adaptNetPositionSeries } from '@/lib/chartAdapters';
import { summarizeVintages } from '@/lib/netPositionProvenance';
import { useModelSelection } from '@/hooks/useForecastModels';

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

export function NetPositionTab() {
  const { data, isLoading, isError } = useNetPositionData();
  const { data: countries } = useCountries();
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const country = countries?.find((c) => c.country_code === selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);

  // Respect the picker like every other tab. Previously this ignored it, so
  // hiding the forecast changed the load chart and did nothing here.
  const { hidden: forecastHidden } = useModelSelection('net_position');

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

  const latest = useMemo(() => {
    const withValue = (data?.actual ?? []).filter((p) => p.net_position_mw != null);
    return withValue.length ? withValue[withValue.length - 1] : null;
  }, [data]);

  const zoneNote = data ? SHARED_ZONE_NOTE[data.meta.bidding_zone] : undefined;

  // A zone that stopped publishing is a data gap, not a loading state. The
  // date has to come from meta.last_seen rather than the returned points:
  // GR and IE both went silent on 2026-03-14, which no recent window
  // contains, so the rows themselves can never name the date.
  const lastSeen = data?.meta.last_seen ? new Date(data.meta.last_seen) : null;
  const hasNothing = !isLoading && (data?.actual.length ?? 0) === 0;
  const isStale =
    !isLoading &&
    lastSeen != null &&
    Date.now() - lastSeen.getTime() > 7 * 24 * 60 * 60 * 1000;

  const subtitleParts = [
    'MW · positive = exporter',
    country?.country_name ?? selectedCountry,
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
          <div className="flex h-[300px] items-center justify-center text-[12px] text-ink-muted">
            Loading…
          </div>
        ) : isError ? (
          <div className="flex h-[300px] items-center justify-center text-[12px] text-ink-muted">
            Could not load net position.
          </div>
        ) : hasNothing ? (
          <div className="flex h-[300px] flex-col items-center justify-center gap-1 text-center text-[12px] text-ink-muted">
            {lastSeen ? (
              <>
                <span>
                  {country?.country_name ?? selectedCountry} stopped publishing a net
                  position on{' '}
                  {lastSeen.toLocaleDateString([], {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                  .
                </span>
                <span className="text-[11px] text-ink-faint">
                  The series ended upstream at ENTSO-E, not here.
                </span>
              </>
            ) : (
              <>
                <span>
                  No net position published for {country?.country_name ?? selectedCountry}.
                </span>
                <span className="text-[11px] text-ink-faint">
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
            />
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-muted">
              {latest && (
                <span className="font-mono-num">
                  latest {formatMw(latest.net_position_mw)}{' '}
                  <span className="text-ink-faint">
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
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
                {vintages.map((v) => (
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
              </div>
            )}
          </>
        )}

        {/* Only as a footnote under a chart that still has points; the empty
            state above already says it when there is nothing to draw. */}
        {isStale && lastSeen && !hasNothing && (
          <p className="mt-2 text-[11px] text-ink-muted">
            No data published since{' '}
            {lastSeen.toLocaleDateString([], {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
            . The series has stopped upstream, not here.
          </p>
        )}

        {zoneNote && <p className="mt-2 text-[11px] text-ink-muted">{zoneNote}</p>}
      </AbleCard>
    </div>
  );
}
