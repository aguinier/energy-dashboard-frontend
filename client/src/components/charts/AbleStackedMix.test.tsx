// @vitest-environment jsdom
//
// Component test needs a DOM; the rest of the suite is pure-module and runs
// in vitest's default node environment (see Figure.test.tsx for the same
// opt-in).
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AbleStackedMix, type AbleStackedMixPoint } from './AbleStackedMix';

const HOUR = 60 * 60 * 1000;
const ts = (h: number) => new Date(h * HOUR).toISOString();

const LABELS = { solar: 'Solar', wind: 'Wind' };
const COLORS = { solar: '#D9A114', wind: '#4D89C9' };

describe('AbleStackedMix — interior data holes', () => {
  afterEach(() => cleanup());

  // The behaviour this suite pins: a null inside an otherwise-reporting group
  // (`energy_generation.solar_mw` null for part of a day while the rest of
  // the mix keeps reporting) must not read as a measured dip to zero. Two
  // parts, both load-bearing per docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md's
  // Edge cases: the area breaks instead of drawing a line through the gap,
  // and the gap is marked with a hatch rather than left silently blank.
  //
  // Two points on each side of the hole (not one), so each side is long
  // enough to actually draw its own filled segment — proving the chart
  // produces TWO separate solar paths rather than bridging index 1 straight
  // to index 4 with one smoothed curve.
  const points: AbleStackedMixPoint[] = [
    { ts: ts(0), future: false, values: { solar: 10, wind: 5 } },
    { ts: ts(1), future: false, values: { solar: 12, wind: 6 } },
    { ts: ts(2), future: false, values: { solar: null, wind: 7 } },
    { ts: ts(3), future: false, values: { solar: null, wind: 8 } },
    { ts: ts(4), future: false, values: { solar: 40, wind: 9 } },
    { ts: ts(5), future: false, values: { solar: 42, wind: 10 } },
  ];

  it('breaks the area into one path per side of the gap, not one path through it', () => {
    const { container } = render(
      <AbleStackedMix series={points} keys={['solar', 'wind']} labels={LABELS} colors={COLORS} />,
    );
    // Wind never has a hole, so it stays one continuous path across all 6
    // points; solar has exactly two, one on each side of the null run.
    expect(container.querySelectorAll('path[data-area-key="wind"]')).toHaveLength(1);
    expect(container.querySelectorAll('path[data-area-key="solar"]')).toHaveLength(2);
  });

  it('never draws a single solar path spanning both sides of the gap', () => {
    const { container } = render(
      <AbleStackedMix series={points} keys={['solar', 'wind']} labels={LABELS} colors={COLORS} />,
    );
    const solarPaths = Array.from(container.querySelectorAll('path[data-area-key="solar"]'));
    // Each segment is a 2-point run, so its smoothed path has exactly one `C`
    // (cubic) command. A path bridging all 4 real solar points (indices
    // 0,1,4,5) into one curve would have three.
    for (const p of solarPaths) {
      expect(p.getAttribute('d')?.match(/C/g)?.length).toBe(1);
    }
  });

  it('marks the gap with a hatched rect naming the affected group', () => {
    const { container } = render(
      <AbleStackedMix series={points} keys={['solar', 'wind']} labels={LABELS} colors={COLORS} />,
    );
    const gapRects = container.querySelectorAll('rect[data-gap-key="solar"]');
    expect(gapRects).toHaveLength(1);
    expect(gapRects[0].getAttribute('data-gap-start-index')).toBe('2');
    expect(gapRects[0].getAttribute('data-gap-end-index')).toBe('3');
    // Wind never had a hole, so it gets no gap marker at all.
    expect(container.querySelectorAll('rect[data-gap-key="wind"]')).toHaveLength(0);
  });

  it('does not mark the unelapsed future as a gap', () => {
    const withFuture: AbleStackedMixPoint[] = [
      ...points,
      { ts: ts(6), future: true, values: { solar: null, wind: null } },
      { ts: ts(7), future: true, values: { solar: null, wind: null } },
    ];
    const { container } = render(
      <AbleStackedMix series={withFuture} keys={['solar', 'wind']} labels={LABELS} colors={COLORS} />,
    );
    // Still exactly the one interior hole from the fixture above — the two
    // future nulls at the tail must not add a second gap for either group.
    expect(container.querySelectorAll('rect[data-gap-key="solar"]')).toHaveLength(1);
    expect(container.querySelectorAll('rect[data-gap-key="wind"]')).toHaveLength(0);
  });

  it('draws one unbroken path per key when nothing is missing (no regression on the common case)', () => {
    const clean: AbleStackedMixPoint[] = [
      { ts: ts(0), future: false, values: { solar: 10, wind: 5 } },
      { ts: ts(1), future: false, values: { solar: 20, wind: 6 } },
      { ts: ts(2), future: false, values: { solar: 30, wind: 7 } },
    ];
    const { container } = render(
      <AbleStackedMix series={clean} keys={['solar', 'wind']} labels={LABELS} colors={COLORS} />,
    );
    expect(container.querySelectorAll('path[data-area-key="solar"]')).toHaveLength(1);
    expect(container.querySelectorAll('path[data-area-key="wind"]')).toHaveLength(1);
    expect(container.querySelectorAll('rect[data-gap-key]')).toHaveLength(0);
  });
});
