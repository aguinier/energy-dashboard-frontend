import { describe, it, expect } from 'vitest';
import {
  RESIZE_ANIMATE_PX,
  reframeTransform,
  shouldAnimateResize,
  smoothScale,
  wheelTargetScale,
} from './mapCamera';

const EXTENT: [number, number] = [1, 24];

describe('wheelTargetScale', () => {
  it('zooms in on a scroll up and out on a scroll down', () => {
    expect(wheelTargetScale(6, -100, 0, EXTENT)).toBeGreaterThan(6);
    expect(wheelTargetScale(6, 100, 0, EXTENT)).toBeLessThan(6);
  });

  it('keeps the handoff travel per notch', () => {
    // One notch of a standard wheel is deltaY 100 in pixel mode, and the
    // element's own wheelDelta made that exp(0.3). The easing changes how it is
    // delivered, not how far it goes.
    expect(wheelTargetScale(1, -100, 0, EXTENT)).toBeCloseTo(Math.exp(0.3), 6);
  });

  it('compounds, so holding the wheel down keeps accelerating', () => {
    const once = wheelTargetScale(2, -100, 0, EXTENT);
    const twice = wheelTargetScale(once, -100, 0, EXTENT);
    expect(twice / once).toBeCloseTo(once / 2, 6);
  });

  it('moves further per event in line mode than in pixel mode', () => {
    expect(wheelTargetScale(2, -3, 1, EXTENT)).toBeGreaterThan(wheelTargetScale(2, -3, 0, EXTENT));
  });

  it('falls back to pixel units for a deltaMode it does not know', () => {
    expect(wheelTargetScale(2, -100, 7, EXTENT)).toBe(wheelTargetScale(2, -100, 0, EXTENT));
  });

  it('clamps to the scale extent at both ends', () => {
    expect(wheelTargetScale(23, -10000, 0, EXTENT)).toBe(24);
    expect(wheelTargetScale(1.2, 10000, 0, EXTENT)).toBe(1);
  });
});

describe('smoothScale', () => {
  it('moves toward the target without overshooting it', () => {
    const next = smoothScale(4, 8, 1 / 60, 0.085);
    expect(next).toBeGreaterThan(4);
    expect(next).toBeLessThan(8);
  });

  it('is frame-rate independent: one long step equals two short ones', () => {
    const tau = 0.085;
    const long = smoothScale(4, 8, 1 / 30, tau);
    const short = smoothScale(smoothScale(4, 8, 1 / 60, tau), 8, 1 / 60, tau);
    expect(long).toBeCloseTo(short, 10);
  });

  it('is symmetric in log space, so zooming out feels like zooming in', () => {
    const tau = 0.085;
    const inward = Math.log(smoothScale(4, 8, 1 / 60, tau) / 4);
    const outward = Math.log(smoothScale(4, 2, 1 / 60, tau) / 4);
    expect(inward).toBeCloseTo(-outward, 10);
  });

  it('converges rather than easing forever', () => {
    let k = 4;
    for (let i = 0; i < 60; i++) k = smoothScale(k, 8, 1 / 60, 0.085);
    expect(k).toBe(8);
  });

  it('lands outright when motion is reduced', () => {
    expect(smoothScale(4, 8, 1 / 60, 0)).toBe(8);
  });

  it('lands outright on a frame that took no time', () => {
    expect(smoothScale(4, 8, 0, 0.085)).toBe(8);
  });
});

describe('reframeTransform', () => {
  // The zone panel opening: 1200x600 loses 380px of width. `fitSize` refits the
  // world into the narrower box, so the projection shrinks with it.
  const opening = {
    transform: { k: 6, x: -200, y: -100 },
    from: { w: 1200, h: 600 },
    to: { w: 820, h: 600 },
    projScale: { from: 190, to: 130 },
    anchor: [300, 220] as [number, number],
    extent: EXTENT,
  };

  it('holds the on-screen scale across the refit', () => {
    const t = reframeTransform(opening);
    expect(t.k * opening.projScale.to).toBeCloseTo(6 * opening.projScale.from, 6);
  });

  it('puts the anchored place back at the centre of the new box', () => {
    const t = reframeTransform(opening);
    expect(t.k * opening.anchor[0] + t.x).toBeCloseTo(820 / 2, 6);
    expect(t.k * opening.anchor[1] + t.y).toBeCloseTo(600 / 2, 6);
  });

  it('is a no-op in scale when the projection did not change', () => {
    const t = reframeTransform({ ...opening, projScale: { from: 130, to: 130 } });
    expect(t.k).toBeCloseTo(6, 10);
  });

  it('gives magnification rather than the place when the extent binds', () => {
    const t = reframeTransform({ ...opening, projScale: { from: 190, to: 10 } });
    expect(t.k).toBe(24);
    expect(t.k * opening.anchor[0] + t.x).toBeCloseTo(820 / 2, 6);
  });
});

describe('shouldAnimateResize', () => {
  it('does not animate the first framing of all', () => {
    expect(shouldAnimateResize(380, true, false)).toBe(false);
  });

  it('animates the zone panel arriving', () => {
    // `.lg-panel` is 380px wide, and the stage loses all of it at once.
    expect(shouldAnimateResize(380, false, false)).toBe(true);
  });

  it('tracks a nudged window edge outright rather than trailing it', () => {
    expect(shouldAnimateResize(RESIZE_ANIMATE_PX - 1, false, false)).toBe(false);
    expect(shouldAnimateResize(6, false, false)).toBe(false);
  });

  it('never animates when motion is reduced', () => {
    expect(shouldAnimateResize(380, false, true)).toBe(false);
  });
});
