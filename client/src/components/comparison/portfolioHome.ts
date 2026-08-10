import type { CrossCountryMetrics } from '@/types';
import { sortForecastTypes } from '@/lib/comparisonConstants';
import { buildLeaderboardRows } from './leaderboardRows';
import { wapeScale } from './accuracyScale';

export function responsePresentTypes(data: CrossCountryMetrics): string[] {
  const types = new Set<string>();
  Object.values(data).forEach((byType) => Object.keys(byType).forEach((type) => types.add(type)));
  return sortForecastTypes([...types]);
}

export function rankingState(data: CrossCountryMetrics, forecastType: string) {
  if (forecastType === 'all') return { kind: 'choose' as const, rows: [] };
  const rows = buildLeaderboardRows(data, forecastType).sort((a, b) => {
    if (a.wape === null) return 1;
    if (b.wape === null) return -1;
    return a.wape - b.wape;
  });
  return { kind: 'rank' as const, rows, scale: wapeScale(rows.map((row) => row.wape)) };
}

export function activatesCountryDetail(event: { key?: string }): boolean {
  return event.key === undefined || event.key === 'Enter' || event.key === ' ';
}
