import type { GridHourSeries } from '@/types';
import { PRICE_RAMP, sampleRamp } from './ramps';

/**
 * The day-ahead price panel: 24 clickable bars, one per hour.
 *
 * Height is scaled within the zone's own day so the shape of its price curve
 * is readable, while colour comes from the same cross-zone ramp the map uses,
 * so a bar and its country agree. An hour with no published price is a gap,
 * not a bar of zero height.
 */

export interface PriceBar {
  hour: number;
  value: number | null;
  /** Pixels, per the design's `18 + share * 46`. */
  height: number;
  color: string;
  current: boolean;
}

const BASE_HEIGHT = 18;
const VARIABLE_HEIGHT = 46;

export interface PriceBarOptions {
  /** Lowest and highest price across all zones at this hour, for colour. */
  scaleMin: number;
  scaleMax: number;
}

export function buildPriceBars(
  series: GridHourSeries | undefined,
  hour: number,
  options?: PriceBarOptions,
): PriceBar[] {
  const values = series ?? [];
  const present = values.filter((v): v is number => v !== null && v !== undefined);

  // Height is relative to the zone's own highest price. Negative prices happen
  // and are not an error: the bar shrinks toward the baseline rather than
  // inverting. Measuring the height off the magnitude instead would make a
  // deeply negative hour the tallest bar on the chart — the cheapest hour of
  // the day drawn as though it were the dearest.
  const peak = present.length ? Math.max(0, ...present) : 0;

  const lo = options?.scaleMin ?? (present.length ? Math.min(...present) : 0);
  const hi = options?.scaleMax ?? (present.length ? Math.max(...present) : 1);
  const span = Math.max(1, hi - lo);

  return Array.from({ length: 24 }, (_, h) => {
    const raw = values[h];
    const value = raw === null || raw === undefined ? null : raw;
    if (value === null) {
      return { hour: h, value: null, height: 0, color: 'transparent', current: h === hour };
    }
    const share = peak > 0 ? Math.max(0, value) / peak : 0;
    return {
      hour: h,
      value,
      height: BASE_HEIGHT + share * VARIABLE_HEIGHT,
      color: sampleRamp(PRICE_RAMP, Math.max(0, Math.min(1, (value - lo) / span))),
      current: h === hour,
    };
  });
}
