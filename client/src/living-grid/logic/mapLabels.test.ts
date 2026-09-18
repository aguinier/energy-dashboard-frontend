import { describe, it, expect } from 'vitest';
import { fadeIn, fitAlpha, labelAnchor, labelFontPx, type Rect } from './mapLabels';

describe('labelFontPx', () => {
  it('grows with the room the country has on screen', () => {
    expect(labelFontPx(150, false)).toBeGreaterThan(labelFontPx(96, false));
    expect(labelFontPx(96, false)).toBeGreaterThan(labelFontPx(40, false));
  });

  it('gives a small zone smaller type than a large one at the same zoom', () => {
    // Belgium against France at the Europe preset, roughly to scale.
    expect(labelFontPx(34, false)).toBeLessThan(labelFontPx(150, false));
  });

  it('keeps the handoff size for a mid-sized country at the reference scale', () => {
    expect(labelFontPx(96, false)).toBeCloseTo(11.5, 6);
  });

  it('grows sub-linearly, so the label never races the country', () => {
    const one = labelFontPx(96, false);
    const four = labelFontPx(96 * 4, false);
    expect(four).toBeGreaterThan(one);
    expect(four).toBeLessThan(one * 4);
  });

  it('reads louder for the selected zone', () => {
    expect(labelFontPx(96, true)).toBeGreaterThan(labelFontPx(96, false));
  });

  it('clamps at both ends', () => {
    expect(labelFontPx(0.0001, false)).toBe(9);
    expect(labelFontPx(1e6, true)).toBe(26);
  });

  it('survives a country with no measurable extent', () => {
    expect(labelFontPx(0, false)).toBe(9);
    expect(labelFontPx(-5, false)).toBe(9);
  });

  it('keeps the smallest zones apart from the largest at the Europe preset', () => {
    // Measured against the real geometry: Luxembourg's mainland is about 14 px
    // across there, Sweden's about 258.
    expect(labelFontPx(14, false)).toBe(9);
    expect(labelFontPx(258, false)).toBeGreaterThan(16);
  });
});

describe('fitAlpha', () => {
  it('is invisible when the label needs far more room than it has', () => {
    expect(fitAlpha(20, 100)).toBe(0);
  });

  it('is fully visible once it comfortably fits', () => {
    expect(fitAlpha(200, 100)).toBe(1);
  });

  it('ramps rather than switching, so a slow zoom fades labels in', () => {
    const mid = fitAlpha(100, 100);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(fitAlpha(105, 100)).toBeGreaterThan(mid);
  });

  it('treats a label needing nothing as visible', () => {
    expect(fitAlpha(50, 0)).toBe(1);
  });
});

describe('fadeIn', () => {
  it('ramps across the band above the threshold', () => {
    expect(fadeIn(100, 100, 40)).toBe(0);
    expect(fadeIn(120, 100, 40)).toBeCloseTo(0.5, 6);
    expect(fadeIn(140, 100, 40)).toBe(1);
  });

  it('stays clamped either side of the band', () => {
    expect(fadeIn(10, 100, 40)).toBe(0);
    expect(fadeIn(1000, 100, 40)).toBe(1);
  });

  it('degrades to a threshold when there is no band', () => {
    expect(fadeIn(100, 100, 0)).toBe(1);
    expect(fadeIn(99, 100, 0)).toBe(0);
  });
});

describe('labelAnchor', () => {
  const bounds: Rect = [
    [100, 100],
    [300, 260],
  ];
  const base = {
    home: [200, 180] as [number, number],
    bounds,
    transform: { k: 1, x: 0, y: 0 },
    size: { w: 800, h: 480 },
    half: { w: 20, h: 12 },
    margin: 8,
  };

  it('leaves a fully visible country labelled where it always was', () => {
    expect(labelAnchor(base)).toEqual([200, 180]);
  });

  it('slides the label over the visible part when the country is half off-screen', () => {
    // Panned so everything left of projection x = 250 is off the left edge.
    const anchor = labelAnchor({ ...base, transform: { k: 1, x: -250, y: 0 } });
    expect(anchor).not.toBeNull();
    expect(anchor![0]).toBeGreaterThan(base.home[0]);
    expect(anchor![0]).toBeLessThanOrEqual(bounds[1][0]);
  });

  it('stops at the edge of the country rather than following the pan out of it', () => {
    // Pan the country off the left edge a step at a time: the label tracks the
    // visible part, but never leaves the country to chase the viewport.
    for (let x = 0; x >= -290; x -= 10) {
      const anchor = labelAnchor({ ...base, transform: { k: 1, x, y: 0 } });
      expect(anchor).not.toBeNull();
      expect(anchor![0]).toBeGreaterThanOrEqual(bounds[0][0]);
      expect(anchor![0]).toBeLessThanOrEqual(bounds[1][0]);
    }
  });

  it('moves smoothly rather than snapping between positions', () => {
    // Far enough left that the clamp is what decides the position, so this
    // exercises the sliding rather than the resting case.
    const a = labelAnchor({ ...base, transform: { k: 1, x: -200, y: 0 } });
    const b = labelAnchor({ ...base, transform: { k: 1, x: -201, y: 0 } });
    expect(a![0]).toBeGreaterThan(base.home[0]);
    expect(Math.abs(a![0] - b![0])).toBeLessThanOrEqual(1.000001);
  });

  it('gives nothing to draw when the country is entirely off-screen', () => {
    expect(labelAnchor({ ...base, transform: { k: 1, x: -900, y: 0 } })).toBeNull();
  });

  it('centres on what is visible when the country is narrower than its label', () => {
    const thin: Rect = [
      [200, 170],
      [210, 190],
    ];
    const anchor = labelAnchor({ ...base, bounds: thin, home: [205, 180] });
    expect(anchor).toEqual([205, 180]);
  });

  it('accounts for zoom when reserving room for the label', () => {
    // At k = 4 the label's 20px half-width is only 5 projection px, so a country
    // that could not hold it at k = 1 can hold it here.
    const thin: Rect = [
      [200, 170],
      [212, 194],
    ];
    const zoomed = labelAnchor({
      ...base,
      bounds: thin,
      home: [201, 180],
      transform: { k: 4, x: -700, y: -600 },
    });
    expect(zoomed).toEqual([205, 180]);
  });

  it('keeps the label off the viewport edge by the margin', () => {
    // The country runs past the left edge; the label must clear the 8px inset.
    const wide: Rect = [
      [-500, 100],
      [300, 260],
    ];
    const anchor = labelAnchor({ ...base, bounds: wide, home: [-400, 180] });
    expect(anchor![0]).toBeCloseTo(8 + 20, 6);
  });

  it('refuses to divide by a transform that has no scale', () => {
    expect(labelAnchor({ ...base, transform: { k: 0, x: 0, y: 0 } })).toBeNull();
  });
});
