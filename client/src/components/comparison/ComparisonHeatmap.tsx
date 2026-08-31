import { useMemo, useState } from 'react';
import { useDashboardStore } from '@/store/dashboardStore';
import { withOpacity } from '@/lib/colors';
import { FORECAST_TYPE_CONFIG, sortForecastTypes } from '@/lib/comparisonConstants';
import type { CrossCountryMetrics } from '@/types';
import { wapeColor, wapeScale, type WapeScale } from './accuracyScale';
import { basisNoticesAcrossTypes, divergentBasisNote, NOT_COMPARABLE } from './basisNotice';
import { activatesCountryDetail } from './portfolioHome';

interface ComparisonHeatmapProps {
  data: CrossCountryMetrics;
}

export function ComparisonHeatmap({ data }: ComparisonHeatmapProps) {
  const { comparisonMetric, comparisonForecastType, goToCountry } = useDashboardStore();
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Extract forecast types present in the data, respecting filter
  const forecastTypes = useMemo(() => {
    if (comparisonForecastType !== 'all') {
      // When a specific type is selected, show only that column
      const hasType = Object.values(data).some((cd) => cd[comparisonForecastType]);
      return hasType ? [comparisonForecastType] : [];
    }
    const types = new Set<string>();
    Object.values(data).forEach((countryData) => {
      Object.keys(countryData).forEach((t) => types.add(t));
    });
    return sortForecastTypes(Array.from(types));
  }, [data, comparisonForecastType]);

  // One scale per column. A column is one forecast type, so its spread is the
  // only comparable basis for colouring its cells — sharing a range across
  // columns would paint every load cell teal and every wind cell terracotta
  // purely because wind is harder to forecast. See accuracyScale.ts.
  const scaleByType = useMemo(() => {
    const scales = new Map<string, WapeScale>();
    for (const type of forecastTypes) {
      scales.set(type, wapeScale(Object.values(data).map((byType) => byType[type]?.wape)));
    }
    return scales;
  }, [data, forecastTypes]);

  const notices = useMemo(
    () => basisNoticesAcrossTypes(data, forecastTypes),
    [data, forecastTypes],
  );

  // Sort countries
  const sortedCountries = useMemo(() => {
    const countries = Object.keys(data).sort();
    if (!sortBy) return countries;

    return countries.sort((a, b) => {
      const valA = data[a]?.[sortBy]?.[comparisonMetric] ?? Infinity;
      const valB = data[b]?.[sortBy]?.[comparisonMetric] ?? Infinity;
      return sortDir === 'asc' ? valA - valB : valB - valA;
    });
  }, [data, sortBy, sortDir, comparisonMetric]);

  const handleSort = (type: string) => {
    if (sortBy === type) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(type);
      setSortDir('asc');
    }
  };

  if (sortedCountries.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No comparison data available
      </div>
    );
  }

  // A whole row navigates on click, not a single cell — in the "all types"
  // view a row can carry several forecast-type columns at once, so there is
  // no one type "the row" was clicked for. A single selected type is passed
  // through so `goToCountry` can scroll the country document straight to that
  // figure; `undefined` in "all" mode leaves it to land at the page's natural
  // top rather than guessing which of several columns the reader meant.
  const clickForecastType = comparisonForecastType !== 'all' ? comparisonForecastType : undefined;

  return (
    <div className="space-y-2">
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="sticky left-0 z-10 bg-muted/50 px-4 py-3 text-left text-xs font-medium text-muted-foreground">
              Country
            </th>
            {forecastTypes.map((type) => (
              <th
                key={type}
                className="px-3 py-3 text-center text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                onClick={() => handleSort(type)}
              >
                <span className="flex items-center justify-center gap-1">
                  {FORECAST_TYPE_CONFIG[type]?.shortLabel || type}
                  {sortBy === type && (
                    <span className="text-foreground">{sortDir === 'asc' ? '↑' : '↓'}</span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedCountries.map((country) => (
            <tr
              key={country}
              role="button"
              tabIndex={0}
              aria-label={`Open ${country} forecast page`}
              className="border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              onClick={() => goToCountry(country, clickForecastType)}
              onKeyDown={(event) => { if (activatesCountryDetail(event)) { event.preventDefault(); goToCountry(country, clickForecastType); } }}
            >
              <td className="sticky left-0 z-10 bg-card px-4 py-2 font-mono text-xs font-medium">
                {country}
              </td>
              {forecastTypes.map((type) => {
                const entry = data[country]?.[type];
                const value = entry?.[comparisonMetric];

                // Withheld because this country's realized and forecast series
                // are not on the same basis (ABL-493). Checked before the
                // generic empty-cell branch below, because the two look
                // identical in the data and mean opposite things: one says we
                // hold nothing, the other says we hold both series in full and
                // their difference is not forecast error.
                const note = divergentBasisNote(entry);
                if (note !== null) {
                  return (
                    <td key={type} className="px-3 py-2 text-center text-xs text-ink-dim" title={note}>
                      {NOT_COMPARABLE}
                    </td>
                  );
                }

                if (value === undefined || value === null || isNaN(value)) {
                  return (
                    <td key={type} className="px-3 py-2 text-center text-xs text-muted-foreground">
                      -
                    </td>
                  );
                }

                const scale = scaleByType.get(type);
                const color = comparisonMetric === 'wape' && scale
                  ? wapeColor(value, scale)
                  : null;
                const formatted = comparisonMetric === 'wape'
                  ? `${value.toFixed(1)}%`
                  : value.toFixed(2);

                return (
                  <td key={type} className="px-3 py-2 text-center">
                    <span
                      className="inline-block rounded px-2 py-0.5 text-xs font-medium"
                      style={color ? { backgroundColor: withOpacity(color, 0.15), color } : undefined}
                    >
                      {formatted}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {/* One line per country whose cells read "not comparable", across every
        column in view — the matrix is the all-types view, so a per-type
        footnote would go missing the moment somebody switched columns. */}
    {notices.length > 0 && (
      <ul className="m-0 list-none space-y-1 px-1 text-micro text-ink-dim">
        {notices.map((notice) => (
          <li key={`${notice.country}-${notice.type}`}>
            <span className="font-mono font-medium">{notice.country}</span>
            {' '}({FORECAST_TYPE_CONFIG[notice.type]?.shortLabel ?? notice.type}) — {notice.note}
          </li>
        ))}
      </ul>
    )}
    {comparisonMetric === 'wape' && (
      <p className="px-1 text-micro text-ink-dim">
        Colour is a country's rank <em>within its own column</em> — best teal, worst terracotta.
        Columns do not compare to each other: load and wind are not equally forecastable, so a teal
        wind cell is not as accurate as a teal load cell. Rank, not distance — read the number for
        the size of the gap. A column with fewer than three measured countries is left uncoloured.
      </p>
    )}
    </div>
  );
}
