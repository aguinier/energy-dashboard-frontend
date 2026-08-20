import type { CrossCountryMetrics, CrossCountryMetricsEntry, SkillVsSeasonalNaive } from '@/types';

/**
 * One leaderboard row: a single country measured on a single forecast type.
 *
 * **A row is always one forecast type.** The leaderboard used to build rows in
 * "All" mode by averaging each metric over whatever types a country happened to
 * have, which produced two wrong numbers at once:
 *
 * 1. **Mixed units.** `mae` for `load` is megawatts and `mae` for `price` is
 *    EUR/MWh. Averaging them adds euros to megawatts and prints the result to
 *    two decimals. Same for `rmse` and `bias`.
 * 2. **Unequal bases.** Coverage is not uniform — measured 2026-08-05 over the
 *    default 30-day window, 20 of the 24 countries had exactly {load, price},
 *    DE and AT had 5 types, FR and BE had 8. So IT's 9.9% "average WAPE" was
 *    load and price only, while BE's 76.8% carried wind_onshore (191%) and
 *    wind_offshore (156%) as well. The table sorted on that by default and
 *    ranked IT seven places of magnitude above BE for forecasts IT is not
 *    measured on at all.
 *
 * Neither has a fix that keeps a single composite number, because there is no
 * defined basis for one: WAPE across types is not averageable (a 7% load error
 * and a 90% wind error are not the same amount of wrong), and no weighting is
 * derivable from the data. So "All" no longer produces rows — the view asks for
 * a forecast type instead. See `ComparisonLeaderboard`.
 */
export interface LeaderboardRow {
  country: string;
  /** `null` when the metric was not measurable in this window — never 0. */
  wape: number | null;
  mae: number | null;
  rmse: number | null;
  bias: number | null;
  dataPoints: number;
  /** Absent only for a stale cached response predating ABL-186 — see `describeSkill`. */
  skill?: SkillVsSeasonalNaive;
  /**
   * Set when every measure above was withheld because this country's realized
   * and forecast series are not on the same basis (ABL-493). The row is then
   * unplaced rather than last, and `basisNote` is what it prints instead of the
   * numbers — see `basisNotice.ts`.
   */
  basis?: 'divergent_basis';
  basisNote?: string;
}

function measured(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Rows for one concrete forecast type, one per country that has an entry for
 * it. Pass a real type — `'all'` yields no rows, by construction.
 */
export function buildLeaderboardRows(
  data: CrossCountryMetrics,
  forecastType: string,
): LeaderboardRow[] {
  const rows: LeaderboardRow[] = [];
  for (const [country, byType] of Object.entries(data)) {
    const entry: CrossCountryMetricsEntry | undefined = byType?.[forecastType];
    if (!entry) continue;
    rows.push({
      country,
      wape: measured(entry.wape),
      mae: measured(entry.mae),
      rmse: measured(entry.rmse),
      bias: measured(entry.bias),
      dataPoints: measured(entry.dataPoints) ?? 0,
      skill: entry.skillVsSeasonalNaive,
      basis: entry.basis,
      basisNote: entry.basisNote,
    });
  }
  return rows;
}

/**
 * Competition ranking by WAPE, best (lowest) first: 1, 2, 2, 4.
 *
 * Countries whose WAPE was not measurable get no rank — they are not "last",
 * they are unplaced, and the denominator excludes them so "#3 of 21" counts
 * only the countries actually in the running.
 *
 * That already covers ABL-493's divergent-basis countries without a branch
 * here: their WAPE arrives `null`, so they drop out of the ranking and out of
 * the denominator by the same rule as an unmeasurable window. What they need
 * beyond that is the *reason*, which is `basisNote`'s job, not this one's.
 */
export function wapeRanks(rows: readonly LeaderboardRow[]): Map<string, number> {
  const ranked = rows
    .filter((r): r is LeaderboardRow & { wape: number } => r.wape !== null)
    .sort((a, b) => a.wape - b.wape);

  const ranks = new Map<string, number>();
  let lastValue: number | null = null;
  let lastRank = 0;
  ranked.forEach((row, index) => {
    const rank = lastValue !== null && row.wape === lastValue ? lastRank : index + 1;
    ranks.set(row.country, rank);
    lastValue = row.wape;
    lastRank = rank;
  });
  return ranks;
}
