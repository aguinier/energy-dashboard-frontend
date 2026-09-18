import type { GridDay, GridDayZone, GridFuelKey } from '@/types';
import { GRID_FUEL_KEYS } from '@/types';
import { EXPORT_RAMP, FUEL_COLORS, IMPORT_RAMP, PRICE_RAMP } from './ramps';
import { resolveNetSeries } from './netFromFlows';
import { ZONES } from './zoneRegistry';
import type { LivingGridState, ViewTab } from './livingGridState';

/**
 * Everything the map element is told, derived from the payload and the hour.
 *
 * This is the one place the four views' visual rules live. The element itself
 * takes colours and labels as given — it knows how to draw a choropleth, a
 * particle field and a corridor arrow, not what a net position means — so
 * every rule here is testable without a canvas.
 */

/** Fill opacity per view. Generation is lighter so the donut rings stay legible. */
const FILL_OPACITY: Record<ViewTab, string> = {
  Balance: '0.78',
  Prices: '0.82',
  Generation: '0.5',
  Market: '0.78',
};

const signedGw = (mw: number): string => {
  const gw = mw / 1000;
  return (gw >= 0 ? '+' : '−') + Math.abs(gw).toFixed(1);
};

/** The fuel with the largest share, or null when the zone reports none. */
export function dominantFuel(
  mix: Record<GridFuelKey, (number | null)[]>,
  hour: number,
): GridFuelKey | null {
  let best: GridFuelKey | null = null;
  let bestValue = -Infinity;
  for (const fuel of GRID_FUEL_KEYS) {
    const value = mix[fuel]?.[hour];
    if (value === null || value === undefined) continue;
    if (value > bestValue) {
      bestValue = value;
      best = fuel;
    }
  }
  return bestValue > 0 ? best : null;
}

/** Mix ring segments — colour and share — dropping slivers under 0.5%. */
export function donutSegments(
  mix: Record<GridFuelKey, (number | null)[]>,
  hour: number,
): [string, number][] {
  const values = GRID_FUEL_KEYS.map((fuel) => {
    const raw = mix[fuel]?.[hour];
    return { fuel, value: raw === null || raw === undefined ? 0 : Math.max(raw, 0) };
  });
  const total = values.reduce((sum, v) => sum + v.value, 0);
  if (total <= 0) return [];
  return values
    .filter((v) => v.value / total > 0.005)
    .map((v) => [FUEL_COLORS[v.fuel], v.value / total] as [string, number]);
}

/**
 * The reference magnitude the net-position two-tone scales against: the 70th
 * percentile of every zone's absolute net position at this hour.
 *
 * A max-based scale would let one outlier hour in one zone flatten the whole
 * continent into two indistinguishable tones, which is exactly what this
 * design is trying not to look like.
 */
export function netReference(magnitudes: number[]): number {
  if (magnitudes.length === 0) return 1;
  const sorted = [...magnitudes].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.7)] || sorted[sorted.length - 1] || 1;
}

/**
 * The price ramp's bounds at one hour, across every zone the day reports.
 *
 * The map colours a country by where its price sits among its neighbours, so
 * anything else drawing a price in the same colours has to scale the same way.
 * A zone scaled against only itself paints a flat day as its own cheapest
 * hour, which is a different claim from the one the map beside it is making.
 */
export function priceScale(day: GridDay, hour: number): { lo: number; hi: number } {
  const prices = ZONES.map((z) => day.zones[z.code])
    .filter((z): z is GridDayZone => z !== undefined)
    .map((z) => z.price[hour])
    .filter((v): v is number => v !== null && v !== undefined);

  return {
    lo: prices.length ? Math.min(...prices) : 0,
    hi: prices.length ? Math.max(...prices) : 1,
  };
}

/**
 * Headroom above the reference before the ramp tops out. The fill and the
 * legend must read this from the same place — a legend that prints a bound the
 * ramp never uses describes a map that is not on screen.
 */
const NET_SCALE_HEADROOM = 1.15;

/** The magnitude at which the ramp saturates: what the legend must print. */
export function netScaleTop(magnitudes: number[]): number {
  return netReference(magnitudes) * NET_SCALE_HEADROOM;
}

/** Position on the four-stop ramp for one zone's net position. */
export function netFillColor(value: number, reference: number): string {
  const t = Math.max(
    0,
    Math.min(0.999, Math.pow(Math.abs(value) / (reference * NET_SCALE_HEADROOM), 0.8)),
  );
  const ramp = value >= 0 ? EXPORT_RAMP : IMPORT_RAMP;
  return ramp[Math.floor(t * ramp.length)];
}

export interface MapAttrs extends Record<string, string | undefined> {
  values: string;
  active: string;
  theme: string;
  flows: string;
  fills: string;
  chips: string;
  donuts: string;
  scalars: string;
  'scalar-colors': string;
  fillop: string;
  speed: string;
  density: string;
  width: string;
  grid: string;
  plants: string;
  labels: string;
  arcs: string;
  seas: string;
  borders: string;
  glow: string;
  'values-on': string;
}

/**
 * Build the whole attribute bag for the current state.
 *
 * Returns plain strings so the host can compare against what it last wrote —
 * writing an unchanged attribute makes the element re-parse and repaint, and
 * `values`/`flows` rebuild the entire vector field.
 */
export function buildMapAttrs(state: LivingGridState, day: GridDay | undefined): MapAttrs {
  const { hour, tab, colourBy, code, L, V } = state;

  // Only zones the payload has data for are part of the dataset — that is what
  // makes a zone clickable and filled, so an absent country stays inert rather
  // than pretending to be a zero.
  const values: Record<string, number> = {};
  const fills: Record<string, string> = {};
  const chips: Record<string, string> = {};
  const donuts: Record<string, [string, number][]> = {};
  const scalars: Record<string, number> = {};
  const flows: Record<string, number> = {};

  if (day) {
    const nets = new Map<string, number | null>();
    for (const zone of ZONES) {
      const data = day.zones[zone.code];
      if (!data) continue;
      values[zone.code] = 1;
      nets.set(zone.code, resolveNetSeries(day, zone.code).series[hour]);
    }

    // Border flows at this hour, for the corridor arrows and the particle field.
    for (const [key, series] of Object.entries(day.flows)) {
      const value = series[hour];
      if (value === null || value === undefined) continue;
      const [a, b] = key.split('-');
      if (values[a] === undefined || values[b] === undefined) continue;
      flows[key] = value;
    }

    const byGeneration = tab === 'Generation';
    const byPrice = colourBy === 'price';

    if (byGeneration) {
      for (const zoneCode of Object.keys(values)) {
        const mix = day.zones[zoneCode]?.mix;
        if (!mix) continue;
        const fuel = dominantFuel(mix, hour);
        if (fuel) fills[zoneCode] = FUEL_COLORS[fuel];
      }
    } else if (!byPrice) {
      const magnitudes = [...nets.values()]
        .filter((v): v is number => v !== null && v !== undefined)
        .map(Math.abs);
      const reference = netReference(magnitudes);
      for (const [zoneCode, value] of nets) {
        if (value === null || value === undefined) continue;
        fills[zoneCode] = netFillColor(value, reference);
      }
    }

    if (byPrice) {
      const { lo, hi } = priceScale(day, hour);
      for (const zoneCode of Object.keys(values)) {
        const price = day.zones[zoneCode]?.price[hour];
        if (price === null || price === undefined) continue;
        scalars[zoneCode] = Math.max(0, Math.min(1, (price - lo) / Math.max(1, hi - lo)));
      }
    }

    if (V.values) {
      for (const zoneCode of Object.keys(values)) {
        const zone = day.zones[zoneCode];
        if (!zone) continue;
        if (tab === 'Prices') {
          const price = zone.price[hour];
          if (price !== null && price !== undefined) chips[zoneCode] = `€${Math.round(price)}`;
          continue;
        }
        if (tab === 'Generation') {
          const total = GRID_FUEL_KEYS.reduce((sum, fuel) => {
            const v = zone.mix[fuel]?.[hour];
            return sum + (v === null || v === undefined ? 0 : Math.max(v, 0));
          }, 0);
          if (total > 0) chips[zoneCode] = `${(total / 1000).toFixed(1)} GW`;
          const segments = donutSegments(zone.mix, hour);
          if (segments.length) donuts[zoneCode] = segments;
          continue;
        }
        const net = nets.get(zoneCode);
        if (net !== null && net !== undefined) chips[zoneCode] = signedGw(net);
      }
    }
  }

  return {
    values: JSON.stringify(values),
    active: code ?? '',
    theme: 'living',
    flows: JSON.stringify(flows),
    fills: JSON.stringify(fills),
    chips: JSON.stringify(chips),
    donuts: JSON.stringify(donuts),
    scalars: colourBy === 'price' ? JSON.stringify(scalars) : '',
    'scalar-colors': PRICE_RAMP.join(','),
    fillop: FILL_OPACITY[tab],
    speed: V.anim ? '1' : '0',
    density: '0.8',
    width: '1.1',
    grid: String(L.grid),
    plants: String(L.plants),
    labels: String(V.labels),
    arcs: String(L.flows),
    seas: 'true',
    borders: String(V.borders),
    glow: String(V.glow),
    'values-on': String(V.values),
  };
}
