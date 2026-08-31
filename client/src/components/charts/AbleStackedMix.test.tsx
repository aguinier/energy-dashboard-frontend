// @vitest-environment jsdom
//
// Component test needs a DOM; the rest of the suite is pure-module and runs
// in vitest's default node environment (see Figure.test.tsx for the same
// opt-in).
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AbleStackedMix, type AbleStackedMixPoint } from './AbleStackedMix';

const HOUR = 60 * 60 * 1000;
const ts = (h: number) => new Date(h * HOUR).toISOString();

const LABELS = { solar: 'Solar', wind: 'Wind' };
// Arbitrary — this generic chart primitive doesn't attach meaning to a
// colour, only draws whatever it's given. Deliberately not the values
// GENERATION_GROUP_COLORS used to hold for these keys (`#D9A114`/`#4D89C9`,
// retired for failing the dataviz skill's accessibility checks): a stale
// copy of a since-changed feature palette in a feature-agnostic component's
// test fixture is confusing, not meaningful.
const COLORS = { solar: '#7A5195', wind: '#37A0C9' };

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

// The direct band labels are what makes GENERATION_GROUP_COLORS's surviving
// CVD/contrast WARNs legal (see that constant's comment) - a colour-only
// encoding is not, a colour paired with a visible name is. That makes this
// mechanism load-bearing for accessibility, not cosmetic, so it gets its own
// coverage: that a label actually renders with the right name and swatch,
// and that the two suppression thresholds (`LABEL_MIN_BAND_HEIGHT`,
// `LABEL_MIN_VERTICAL_GAP`) genuinely fire rather than being dead code.
describe('AbleStackedMix — direct band labels', () => {
  afterEach(() => cleanup());

  it('labels each drawn band with its own swatch colour and name, at the band\'s last reported point', () => {
    const clean: AbleStackedMixPoint[] = [
      { ts: ts(0), future: false, values: { solar: 10, wind: 5 } },
      { ts: ts(1), future: false, values: { solar: 20, wind: 6 } },
      { ts: ts(2), future: false, values: { solar: 30, wind: 7 } },
    ];
    const { container } = render(
      <AbleStackedMix series={clean} keys={['solar', 'wind']} labels={LABELS} colors={COLORS} />,
    );
    const solarLabel = container.querySelector('g[data-band-label-key="solar"]');
    const windLabel = container.querySelector('g[data-band-label-key="wind"]');
    expect(solarLabel).not.toBeNull();
    expect(windLabel).not.toBeNull();
    expect(solarLabel!.querySelector('text')?.textContent).toBe('Solar');
    expect(solarLabel!.querySelector('rect')?.getAttribute('fill')).toBe(COLORS.solar);
    expect(windLabel!.querySelector('text')?.textContent).toBe('Wind');
    expect(windLabel!.querySelector('rect')?.getAttribute('fill')).toBe(COLORS.wind);
  });

  it('drops the label for a band too thin to hold one, keeping a tall neighbour\'s', () => {
    // Single point: a=100, b=2. Height scales as value/yMax*ih (default
    // height=220 -> ih=182), so a's band is comfortably tall (~162px) and
    // b's is a sliver (~3px) - nowhere near the 12px floor, deliberately
    // not a boundary case, since this test is about the floor existing at
    // all, not its exact placement.
    const thin: AbleStackedMixPoint[] = [{ ts: ts(0), future: false, values: { a: 100, b: 2 } }];
    const { container } = render(
      <AbleStackedMix
        series={thin}
        keys={['a', 'b']}
        labels={{ a: 'Alpha', b: 'Bravo' }}
        colors={{ a: '#111111', b: '#222222' }}
      />,
    );
    expect(container.querySelector('g[data-band-label-key="a"]')).not.toBeNull();
    expect(container.querySelector('g[data-band-label-key="b"]')).toBeNull();
  });

  it('drops a label that would collide with an already-kept neighbour, even though neither band is individually thin', () => {
    // Single point, values chosen (and checked against the component's own
    // scale/stack math) so that:
    //   - a and b each clear the 12px minimum band height on their own
    //     (~12.6px each) - neither is suppressed for being thin.
    //   - a and b's label centres land ~12.6px apart - under the 13px
    //     minimum gap, so b collides with a (processed first, bottom of
    //     stack) and is dropped.
    //   - c is a tall, distant band (~140px, ~89px from a's centre) that
    //     collides with nothing and is kept.
    // Processing is bottom-of-stack first (`keys` order), so a keeps its
    // label and b - not a - is the one dropped.
    const colliding: AbleStackedMixPoint[] = [
      { ts: ts(0), future: false, values: { a: 45, b: 45, c: 500 } },
    ];
    const { container } = render(
      <AbleStackedMix
        series={colliding}
        keys={['a', 'b', 'c']}
        labels={{ a: 'Alpha', b: 'Bravo', c: 'Charlie' }}
        colors={{ a: '#111111', b: '#222222', c: '#333333' }}
      />,
    );
    expect(container.querySelector('g[data-band-label-key="a"]')).not.toBeNull();
    expect(container.querySelector('g[data-band-label-key="b"]')).toBeNull();
    expect(container.querySelector('g[data-band-label-key="c"]')).not.toBeNull();
  });
});

// jsdom never lays out real geometry, so `getBoundingClientRect` on the SVG
// returns all zeros by default; without a mock every ratio in
// `hoverIndexFromClientX` divides by a zero width and the resulting NaN
// index never resolves to a real point. Mocking it to a concrete pixel box
// is the only way to exercise the hover math at all — mouse or touch.
describe('AbleStackedMix — touch support for the hover tooltip', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const clean: AbleStackedMixPoint[] = [
    { ts: ts(0), future: false, values: { solar: 10, wind: 5 } },
    { ts: ts(1), future: false, values: { solar: 20, wind: 6 } },
    { ts: ts(2), future: false, values: { solar: 30, wind: 7 } },
  ];

  it('opens the hover tooltip on a tap (touchstart), not just on mouse hover', () => {
    // This is the fallback the direct labels above lean on when a band is
    // too thin to hold one: the tooltip names every drawn group regardless
    // of thinness. In the country document's Generation figure there is no
    // SourceTable to fall back to instead (see GenerationTab's
    // `variant="figure"`), so a mouse-only tooltip left that fallback
    // unreachable on a touch device - this pins that it now is reachable.
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 680, height: 220, left: 0, top: 0, right: 680, bottom: 220, x: 0, y: 0,
      toJSON() { return {}; },
    } as DOMRect);
    const { container } = render(
      <AbleStackedMix series={clean} keys={['solar', 'wind']} labels={LABELS} colors={COLORS} />,
    );
    const svg = container.querySelector('svg')!;

    expect(screen.queryByText('Net generation')).toBeNull();
    fireEvent.touchStart(svg, { touches: [{ clientX: 340, clientY: 100 }] });
    expect(screen.queryByText('Net generation')).not.toBeNull();
  });
});
