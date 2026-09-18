import { describe, it, expect } from 'vitest';
import { TWEEN_MS, easeProgress, lerpColor, lerpColorMap, lerpNumberMap } from './tween';

describe('easeProgress', () => {
  it('is exact at both ends, so a tween lands on the real value', () => {
    expect(easeProgress(0, 650)).toBe(0);
    expect(easeProgress(650, 650)).toBe(1);
  });

  it('clamps rather than overshooting when a frame arrives late', () => {
    expect(easeProgress(5000, 650)).toBe(1);
    expect(easeProgress(-20, 650)).toBe(0);
  });

  it('is monotonic through the middle', () => {
    const samples = [0, 100, 200, 325, 450, 600, 650].map((ms) => easeProgress(ms, 650));
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
  });

  it('is symmetric about the halfway point, as an in-out curve should be', () => {
    expect(easeProgress(325, 650)).toBeCloseTo(0.5, 10);
    expect(easeProgress(162.5, 650) + easeProgress(487.5, 650)).toBeCloseTo(1, 10);
  });

  it('eases rather than running linearly', () => {
    // A quarter of the way through, a cubic in-out has covered much less than
    // a quarter of the distance — that is the whole point of it.
    expect(easeProgress(162.5, 650)).toBeLessThan(0.25);
  });

  it('lands immediately when there is no duration — the reduced-motion path', () => {
    expect(easeProgress(0, 0)).toBe(1);
    expect(easeProgress(0, -1)).toBe(1);
  });
});

describe('lerpColor', () => {
  it('returns each end exactly at t 0 and 1', () => {
    expect(lerpColor('#000000', '#ffffff', 0)).toBe('#000000');
    expect(lerpColor('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('sits between its endpoints on every channel', () => {
    const mid = lerpColor('#204080', '#80c0f0', 0.5);
    const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    for (let i = 0; i < 3; i++) {
      expect(channel(mid, i)).toBeGreaterThan(channel('#204080', i));
      expect(channel(mid, i)).toBeLessThan(channel('#80c0f0', i));
    }
  });

  it('always emits a well-formed six-digit hex', () => {
    for (const t of [0, 0.13, 0.5, 0.87, 1]) {
      expect(lerpColor('#0b0e12', '#2fd3c0', t)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('degrades to a cut rather than to black on a colour it cannot parse', () => {
    // The map's rim colours are rgba() strings; feeding one here must not
    // silently produce #000000 across the whole map.
    expect(lerpColor('rgba(1,2,3,0.5)', '#2fd3c0', 0.2)).toBe('rgba(1,2,3,0.5)');
    expect(lerpColor('rgba(1,2,3,0.5)', '#2fd3c0', 0.8)).toBe('#2fd3c0');
  });
});

describe('lerpNumberMap', () => {
  it('interpolates a key both sides have', () => {
    expect(lerpNumberMap({ DE: 0 }, { DE: 100 }, 0.25).DE).toBeCloseTo(25, 10);
  });

  it('takes the side that has it rather than easing toward zero', () => {
    // A zone the other hour has no value for is not a zone at zero. Easing it
    // through the middle would draw a measurement nobody took.
    expect(lerpNumberMap({ DE: 4000 }, {}, 0.5)).toEqual({ DE: 4000 });
    expect(lerpNumberMap({}, { FR: -2000 }, 0.5)).toEqual({ FR: -2000 });
  });

  it('covers the union of both sides', () => {
    const out = lerpNumberMap({ DE: 1 }, { FR: 2 }, 0.5);
    expect(Object.keys(out).sort()).toEqual(['DE', 'FR']);
  });

  it('crosses zero rather than jumping the sign', () => {
    expect(lerpNumberMap({ DE: -1000 }, { DE: 1000 }, 0.5).DE).toBeCloseTo(0, 10);
  });
});

describe('lerpColorMap', () => {
  it('blends a zone both hours colour', () => {
    expect(lerpColorMap({ DE: '#000000' }, { DE: '#ffffff' }, 1).DE).toBe('#ffffff');
  });

  it('keeps a zone only one hour has, at its own colour', () => {
    expect(lerpColorMap({ DE: '#2fd3c0' }, {}, 0.5)).toEqual({ DE: '#2fd3c0' });
    expect(lerpColorMap({}, { FR: '#e8a33d' }, 0.5)).toEqual({ FR: '#e8a33d' });
  });
});

describe('TWEEN_MS', () => {
  it('comes to rest inside one play interval', () => {
    // PLAY_INTERVAL_MS is 900 in LivingGridView. A tween longer than that would
    // never settle, so the hour on screen would never be legible.
    expect(TWEEN_MS).toBeLessThan(900);
    expect(TWEEN_MS).toBeGreaterThan(300);
  });
});
