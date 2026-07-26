import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { AbleLineChart } from '@/components/charts/AbleLineChart';
import { useNetPositionData } from '@/hooks/useNetPositionData';
import { useCountries } from '@/hooks/useCountries';
import { useDashboardStore } from '@/store/dashboardStore';
import { adaptNetPositionSeries } from '@/lib/chartAdapters';
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

  // Respect the picker like every other tab. Previously this ignored it, so
  // hiding the forecast changed the load chart and did nothing here.
  const { hidden: forecastHidden } = useModelSelection('net_position');

  const shown = useMemo(
    () => (forecastHidden && data ? { ...data, forecast: [] } : data),
    [data, forecastHidden],
  );

  const { series, nowIndex } = useMemo(() => adaptNetPositionSeries(shown), [shown]);

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
  if (!forecastHidden && data?.meta.generated_at) {
    subtitleParts.push(
      `forecast ${data.meta.model_name ?? 'model'} · generated ${new Date(
        data.meta.generated_at,
      ).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
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
