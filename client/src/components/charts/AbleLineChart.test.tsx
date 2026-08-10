import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { AbleLineChart, type AbleSeriesPoint } from './AbleLineChart';

/**
 * Renders the real chart to SVG. `renderToString` needs no DOM, so this runs in
 * the default node environment with no new dependency.
 *
 * It exists because ABL-92 was invisible everywhere else: the server served the
 * past-dated forecast points, the hook requested them, and the adapter placed
 * them in the grid. They were dropped at the last step, when the path was built,
 * so only the rendered geometry can prove they are back. Measured against the
 * replica on 2026-08-09, FR/load over 7d returns 204 forecast points of which
 * 168 are past-dated; with FR's actuals ~14h behind, the truncated version left
 * a band of chart carrying neither series.
 */

// Geometry constants from the component's own layout — the assertions below are
// about which x-range the path covers, so they have to agree with it.
const WIDTH = 680;
const PAD_L = 44;
const PAD_R = 16;
const IW = WIDTH - PAD_L - PAD_R;
const N = 24;
const NOW_INDEX = 12;
const xFor = (i: number) => PAD_L + (i / (N - 1)) * IW;

/** Every `<path>` element's `d`, keyed by the stroke-dasharray that identifies it. */
function pathsByDash(html: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const tag of html.match(/<path[^>]*>/g) ?? []) {
    const d = /\sd="([^"]*)"/.exec(tag)?.[1];
    if (!d) continue;
    const dash = /stroke-dasharray="([^"]*)"/.exec(tag)?.[1] ?? 'solid';
    out.set(dash, [...(out.get(dash) ?? []), d]);
  }
  return out;
}

/** The dashed forecast stroke. Band edges use "3 3"; the actual line is solid. */
const forecastPath = (html: string) => pathsByDash(html).get('4,4')?.[0] ?? '';

/** X coordinates of every command in a path, in order. */
function xsOf(d: string): number[] {
  return [...d.matchAll(/[ML]\s*(-?[\d.]+),/g)].map((m) => Number(m[1]));
}

/** How many subpaths the stroke is broken into. */
const subpathCount = (d: string) => (d.match(/M/g) ?? []).length;

/**
 * 24 hourly slots. Actuals stop at slot 9 — three hours before `now` at slot 12
 * — which is the shape the Board screenshotted: a trailing actuals gap with a
 * forecast that should span it.
 */
function series(opts: { forecastAt: (i: number) => number | null }): AbleSeriesPoint[] {
  return Array.from({ length: N }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 7, 9, i)).toISOString(),
    future: i > NOW_INDEX,
    value: i <= 9 ? 36_000 + i * 100 : null,
    forecast: opts.forecastAt(i),
  }));
}

const render = (s: AbleSeriesPoint[], overlay = false) =>
  renderToString(
    <AbleLineChart series={s} nowIndex={NOW_INDEX} width={WIDTH} overlay={overlay} smooth={false} />,
  );

describe('AbleLineChart forecast rendering', () => {
  it('draws the forecast from the first stored point, not from the now marker', () => {
    const d = forecastPath(render(series({ forecastAt: () => 44_500 })));
    expect(d).not.toBe('');

    const xs = xsOf(d);
    // The regression: this used to start at xFor(NOW_INDEX) ≈ 367.5, discarding
    // every past-dated point the server had served.
    expect(Math.min(...xs)).toBeCloseTo(xFor(0), 1);
    expect(Math.max(...xs)).toBeCloseTo(xFor(N - 1), 1);
    expect(Math.min(...xs)).toBeLessThan(xFor(NOW_INDEX));
  });

  it('covers the band between the last actual and now, where neither series used to draw', () => {
    const d = forecastPath(render(series({ forecastAt: () => 44_500 })));
    const xs = xsOf(d);
    // Slots 10, 11 and 12: after the last actual, at or before now.
    for (const i of [10, 11, NOW_INDEX]) {
      expect(xs.some((x) => Math.abs(x - xFor(i)) < 0.5)).toBe(true);
    }
  });

  it('overlaps the actuals region so forecast can be read against realised', () => {
    const html = render(series({ forecastAt: () => 44_500 }));
    const xs = xsOf(forecastPath(html));
    // Slot 0 carries an actual AND a forecast; both must be drawn there.
    expect(xs.some((x) => Math.abs(x - xFor(0)) < 0.5)).toBe(true);
    const solid = pathsByDash(html).get('solid') ?? [];
    expect(solid.some((d) => xsOf(d).some((x) => Math.abs(x - xFor(0)) < 0.5))).toBe(true);
  });

  it('renders one unbroken subpath when every hour has a forecast', () => {
    expect(subpathCount(forecastPath(render(series({ forecastAt: () => 44_500 }))))).toBe(1);
  });

  it('leaves a hole where no forecast was published rather than bridging it', () => {
    // Hours 10-13 missing: a skipped model run must not become a straight
    // dashed line across four hours nothing was forecast for.
    const d = forecastPath(
      render(series({ forecastAt: (i) => (i >= 10 && i <= 13 ? null : 44_500) })),
    );
    expect(subpathCount(d)).toBe(2);
    const xs = xsOf(d);
    for (const i of [10, 11, 12, 13]) {
      expect(xs.some((x) => Math.abs(x - xFor(i)) < 0.5)).toBe(false);
    }
  });

  it('draws nothing dashed when there is no forecast at all', () => {
    expect(forecastPath(render(series({ forecastAt: () => null })))).toBe('');
  });

  it('is unaffected by `overlay`, which now only controls the now marker', () => {
    const s = series({ forecastAt: () => 44_500 });
    expect(forecastPath(render(s, true))).toBe(forecastPath(render(s, false)));
  });
});
