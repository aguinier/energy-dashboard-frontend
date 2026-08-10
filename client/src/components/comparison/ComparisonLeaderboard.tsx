import { useMemo, useState } from 'react';
import { useDashboardStore } from '@/store/dashboardStore';
import { withOpacity } from '@/lib/colors';
import { FORECAST_TYPE_CONFIG, FORECAST_TYPE_MAP_OPTIONS } from '@/lib/comparisonConstants';
import { cn } from '@/lib/utils';
import type { CrossCountryMetrics } from '@/types';
import { wapeColor, wapeScale } from './accuracyScale';
import { buildLeaderboardRows, wapeRanks, type LeaderboardRow } from './leaderboardRows';

type SortField = 'country' | 'wape' | 'mae' | 'rmse' | 'bias' | 'dataPoints';

interface ComparisonLeaderboardProps {
  data: CrossCountryMetrics;
}

/**
 * "All" cannot produce a leaderboard row — MAE in megawatts and MAE in
 * EUR/MWh do not average, and countries do not cover the same set of types.
 * See `leaderboardRows.ts`. Rather than print a composite nobody can define,
 * ask for the one thing that makes the ranking well-posed.
 */
function PickAForecastType({ available }: { available: string[] }) {
  const setComparisonForecastType = useDashboardStore((s) => s.setComparisonForecastType);
  const options = FORECAST_TYPE_MAP_OPTIONS.filter((o) => available.includes(o.value));

  return (
    <div className="rounded-lg border bg-card p-8 text-center">
      <p className="m-0 text-body font-medium text-foreground">
        Pick a forecast type to rank countries
      </p>
      <p className="mx-auto mt-2 max-w-[52ch] text-sm text-ink-dim">
        A single ranking across all types would have to average errors measured in
        different units (load in MW, price in EUR/MWh) over a different set of
        types for each country — so it would order the table by which forecasts a
        country happens to have, not by how good they are. The Heatmap tab shows
        every type side by side.
      </p>
      {options.length > 0 && (
        <div className="mt-5 flex flex-wrap justify-center gap-1.5">
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setComparisonForecastType(opt.value)}
              className="rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-background"
            >
              {FORECAST_TYPE_CONFIG[opt.value]?.label ?? opt.value}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ComparisonLeaderboard({ data }: ComparisonLeaderboardProps) {
  const { comparisonForecastType, goToCountry } = useDashboardStore();
  const [sortField, setSortField] = useState<SortField>('wape');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const availableTypes = useMemo(() => {
    const types = new Set<string>();
    Object.values(data).forEach((byType) => Object.keys(byType).forEach((t) => types.add(t)));
    return Array.from(types);
  }, [data]);

  const rows = useMemo(
    () => (comparisonForecastType === 'all' ? [] : buildLeaderboardRows(data, comparisonForecastType)),
    [data, comparisonForecastType],
  );

  // One scale for the whole column, built from this forecast type's own
  // spread — never shared with another type. See accuracyScale.ts.
  const scale = useMemo(() => wapeScale(rows.map((r) => r.wape)), [rows]);
  const ranks = useMemo(() => wapeRanks(rows), [rows]);

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (sortField === 'country') {
        return sortDir === 'asc'
          ? a.country.localeCompare(b.country)
          : b.country.localeCompare(a.country);
      }
      // Unmeasurable sorts last in both directions — it is missing, not extreme.
      const valA = a[sortField];
      const valB = b[sortField];
      if (valA === null && valB === null) return 0;
      if (valA === null) return 1;
      if (valB === null) return -1;
      return sortDir === 'asc' ? valA - valB : valB - valA;
    });
  }, [rows, sortField, sortDir]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const SortHeader = ({ field, label, align = 'center' }: { field: SortField; label: string; align?: string }) => (
    <th
      className={cn(
        'px-4 py-3 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground transition-colors',
        align === 'left' ? 'text-left' : 'text-center'
      )}
      onClick={() => handleSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortField === field && (
          <span className="text-foreground">{sortDir === 'asc' ? '↑' : '↓'}</span>
        )}
      </span>
    </th>
  );

  if (comparisonForecastType === 'all') {
    return <PickAForecastType available={availableTypes} />;
  }

  if (sortedRows.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No leaderboard data available
      </div>
    );
  }

  const typeConfig = FORECAST_TYPE_CONFIG[comparisonForecastType];
  const unit = typeConfig?.unit ?? '';

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-center text-xs font-medium text-muted-foreground w-12">
                #
              </th>
              <SortHeader field="country" label="Country" align="left" />
              <SortHeader field="wape" label="WAPE" />
              <SortHeader field="mae" label={unit ? `MAE (${unit})` : 'MAE'} />
              <SortHeader field="rmse" label={unit ? `RMSE (${unit})` : 'RMSE'} />
              <SortHeader field="bias" label={unit ? `Bias (${unit})` : 'Bias'} />
              <SortHeader field="dataPoints" label="Data Pts" />
              <th className="px-4 py-3 text-center text-xs font-medium text-muted-foreground">
                Standing
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row: LeaderboardRow, idx) => {
              const color = wapeColor(row.wape, scale);
              const rank = ranks.get(row.country);

              return (
                <tr
                  key={row.country}
                  className="border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => goToCountry(row.country, 'analytics')}
                >
                  <td className="px-4 py-3 text-center text-xs text-muted-foreground font-mono">
                    {idx + 1}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs font-medium">
                    {row.country}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {row.wape !== null ? (
                      <span
                        className="inline-block rounded px-2 py-0.5 text-xs font-medium"
                        style={color ? { backgroundColor: withOpacity(color, 0.15), color } : undefined}
                      >
                        {row.wape.toFixed(1)}%
                      </span>
                    ) : '-'}
                  </td>
                  <td className="px-4 py-3 text-center text-xs">
                    {row.mae !== null ? row.mae.toFixed(2) : '-'}
                  </td>
                  <td className="px-4 py-3 text-center text-xs">
                    {row.rmse !== null ? row.rmse.toFixed(2) : '-'}
                  </td>
                  <td className="px-4 py-3 text-center text-xs">
                    {row.bias !== null ? (
                      <span className={row.bias > 0 ? 'text-amber-500' : 'text-sky-500'}>
                        {row.bias > 0 ? '+' : ''}{row.bias.toFixed(2)}
                      </span>
                    ) : '-'}
                  </td>
                  <td className="px-4 py-3 text-center text-xs text-muted-foreground">
                    {row.dataPoints.toLocaleString()}
                  </td>
                  {/* An exact position, not a grade. Nothing in the data says
                      what WAPE a forecast *should* reach, so the column states
                      the one thing it can support: where this country sits
                      among the countries measured on the same forecast type. */}
                  <td className="px-4 py-3 text-center">
                    {rank !== undefined ? (
                      <span className="font-mono-num text-xs text-muted-foreground">
                        #{rank}<span className="text-ink-faint"> / {scale.count}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">not measurable</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="px-1 text-micro text-ink-dim">
        WAPE colour is each country's <em>rank</em> among the {scale.count} measured for{' '}
        {typeConfig?.label.toLowerCase() ?? comparisonForecastType} in this window — best teal, worst
        terracotta, ties share a colour. Rank, not distance: neighbouring shades can be a tenth of a
        point apart or twenty. Read the number for that. It is a standing among peers, not a
        pass/fail grade — nothing in this data defines a target WAPE.
      </p>
    </div>
  );
}
