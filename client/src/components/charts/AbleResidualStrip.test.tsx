// @vitest-environment jsdom
//
// Component test needs a DOM; the rest of the suite is pure-module and runs in
// vitest's default node environment (see Figure.test.tsx for the same opt-in).
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AbleResidualStrip } from './AbleResidualStrip';
import { PLOT_MARGINS } from './AbleLineChart';

const HOUR = 60 * 60 * 1000;
const iso = (h: number) => new Date(h * HOUR).toISOString();

describe('AbleResidualStrip', () => {
  afterEach(() => cleanup());

  it('draws one bar per residual point', () => {
    const { container } = render(
      <AbleResidualStrip
        points={[
          { t: iso(0), residual: 10 },
          { t: iso(1), residual: -5 },
          { t: iso(2), residual: 2 },
        ]}
        domain={{ start: iso(0), end: iso(2) }}
      />
    );
    expect(container.querySelectorAll('rect[data-residual]')).toHaveLength(3);
  });

  it('signs the bars, so over- and under-forecast are distinguishable', () => {
    const { container } = render(
      <AbleResidualStrip
        points={[{ t: iso(0), residual: 10 }, { t: iso(1), residual: -5 }]}
        domain={{ start: iso(0), end: iso(1) }}
      />
    );
    const bars = Array.from(container.querySelectorAll('rect[data-residual]'));
    expect(bars.map((b) => b.getAttribute('data-sign'))).toEqual(['over', 'under']);
  });

  it('renders nothing when there is nothing to show', () => {
    const { container } = render(<AbleResidualStrip points={[]} domain={{ start: iso(0), end: iso(1) }} />);
    expect(container.innerHTML).toBe('');
  });

  it('states the peak magnitude so the strip has a scale', () => {
    render(<AbleResidualStrip points={[{ t: iso(0), residual: 1234 }]} domain={{ start: iso(0), end: iso(0) }} />);
    expect(screen.queryByText(/1,234/)).not.toBeNull();
  });

  // The bug this component existed to fix: bars used to be spaced by array
  // index, so a missing hour shifted every later bar one slot left, and the
  // strip spanned the raw container edge to edge while the plot above it
  // insets its drawable area behind a y-axis gutter and a right margin.
  describe('alignment with the plot above it', () => {
    it('positions a bar by elapsed time against the domain, not by its index in the array', () => {
      // Hour 2 is missing entirely — a dropped interval, not a zero. If bars
      // were still spaced by array index, hour 3's bar would land where hour
      // 2's belongs (index 2 of 4, not 3 of 5).
      const { container } = render(
        <AbleResidualStrip
          points={[
            { t: iso(0), residual: 1 },
            { t: iso(1), residual: 1 },
            { t: iso(3), residual: 1 },
            { t: iso(4), residual: 1 },
          ]}
          domain={{ start: iso(0), end: iso(4) }}
        />
      );
      const bars = Array.from(container.querySelectorAll('rect[data-residual]'));
      const xs = bars.map((b) => Number(b.getAttribute('x')));
      const { width, padL, padR } = PLOT_MARGINS;
      const iw = width - padL - padR;
      const xForHour = (h: number) => padL + (h / 4) * iw;
      expect(xs[0]).toBeCloseTo(xForHour(0), 5);
      expect(xs[1]).toBeCloseTo(xForHour(1), 5);
      expect(xs[2]).toBeCloseTo(xForHour(3), 5); // NOT xForHour(2) — index-based spacing would put it here
      expect(xs[3]).toBeCloseTo(xForHour(4), 5);
    });

    it('insets its drawable area behind the same y-axis gutter and right margin as AbleLineChart, not the raw 0-100% container', () => {
      const { container } = render(
        <AbleResidualStrip points={[{ t: iso(0), residual: 5 }]} domain={{ start: iso(0), end: iso(1) }} />
      );
      const bar = container.querySelector('rect[data-residual]');
      const zeroLine = container.querySelector('line');
      expect(Number(bar?.getAttribute('x'))).toBeCloseTo(PLOT_MARGINS.padL, 5);
      expect(Number(zeroLine?.getAttribute('x1'))).toBe(PLOT_MARGINS.padL);
      expect(Number(zeroLine?.getAttribute('x2'))).toBe(PLOT_MARGINS.width - PLOT_MARGINS.padR);
    });

    it('shares AbleLineChart\'s viewBox width, so 1 unit means the same fraction of the rendered width in both', () => {
      const { container } = render(
        <AbleResidualStrip points={[{ t: iso(0), residual: 5 }]} domain={{ start: iso(0), end: iso(1) }} />
      );
      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('viewBox')).toBe(`0 0 ${PLOT_MARGINS.width} 46`);
    });

    it('drops a residual that falls outside the plot domain rather than drawing it under the wrong instant', () => {
      const { container } = render(
        <AbleResidualStrip
          points={[
            { t: iso(-5), residual: 1 }, // well before the domain
            { t: iso(0), residual: 1 },
          ]}
          domain={{ start: iso(0), end: iso(1) }}
        />
      );
      expect(container.querySelectorAll('rect[data-residual]')).toHaveLength(1);
    });
  });
});
