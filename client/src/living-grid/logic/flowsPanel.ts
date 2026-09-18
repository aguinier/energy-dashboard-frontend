import type { GridHourSeries } from '@/types';
import { ZONE_BY_CODE } from './zoneRegistry';

/**
 * The cross-border flows panel: the zone's busiest borders at this hour.
 *
 * Sign is from the selected zone's point of view — positive means it is
 * exporting to that neighbour — which is a different convention from the
 * payload's alphabetical border keys, so the flip happens here once rather
 * than in every consumer.
 */

export interface FlowRow {
  /** The neighbour's zone code. */
  other: string;
  /** The neighbour's name, or its code when it is outside the registry. */
  label: string;
  /** MW, positive when the selected zone exports. */
  mw: number;
  exporting: boolean;
}

/** How many borders the panel lists, per the design. */
export const MAX_FLOW_ROWS = 7;

/**
 * Whether a border key joins `code` to somewhere.
 *
 * A key names exactly two zones, `from-to`. Anything that reads a key more
 * loosely than the row builder does — testing every hyphen-separated segment,
 * say — can count a border the rows path then ignores, and the panel ends up
 * claiming data on a border it declines to list.
 */
export function borderTouches(key: string, code: string): boolean {
  const [a, b] = key.split('-');
  return a === code || b === code;
}

export function buildFlowRows(
  flows: Record<string, GridHourSeries>,
  code: string | null,
  hour: number,
  limit = MAX_FLOW_ROWS,
): FlowRow[] {
  if (!code) return [];

  const rows: FlowRow[] = [];
  for (const [key, series] of Object.entries(flows)) {
    if (!borderTouches(key, code)) continue;
    const [a, b] = key.split('-');
    const value = series[hour];
    if (value === null || value === undefined) continue;

    const other = a === code ? b : a;
    const mw = a === code ? value : -value;
    rows.push({
      other,
      label: ZONE_BY_CODE[other]?.name ?? other,
      mw,
      exporting: mw >= 0,
    });
  }

  return rows.sort((x, y) => Math.abs(y.mw) - Math.abs(x.mw)).slice(0, limit);
}

/** Total import and export across every reported border, for the key figures. */
export function flowTotals(
  flows: Record<string, GridHourSeries>,
  code: string | null,
  hour: number,
): { exported: number; imported: number; net: number } | null {
  const rows = buildFlowRows(flows, code, hour, Number.MAX_SAFE_INTEGER);
  if (rows.length === 0) return null;
  const exported = rows.filter((r) => r.mw > 0).reduce((s, r) => s + r.mw, 0);
  const imported = rows.filter((r) => r.mw < 0).reduce((s, r) => s - r.mw, 0);
  return { exported, imported, net: exported - imported };
}
