import { wape } from './wape.js';

/**
 * WAPE over the accuracy-point shape the TSO services return.
 *
 * This is NOT a second WAPE definition — `services/wape.ts` stays the only
 * one, and this reduces through it. What lives here is the reconstruction:
 * `ForecastAccuracyDataPoint` carries `error = actual - forecast` rather than
 * the forecast itself, so `forecast = actual_value - error`. That inversion is
 * easy to get backwards and was worth writing down once, with a test, instead
 * of inline at each of the two call sites.
 */
export function wapeFromAccuracyPoints(
  points: Array<{ actual_value: number; error: number }>
): number | null {
  return wape(points.map((d) => ({
    actual: d.actual_value,
    forecast: d.actual_value - d.error,
  })));
}
