import { describe, it, expect } from 'vitest';
import { buildSparkline, SPARK_MID, SPARK_REACH, SPARK_WIDTH } from './sparkline';
import { series } from './testFixture';

describe('buildSparkline', () => {
  it('spans the full width and puts zero through the middle', () => {
    const s = buildSparkline(series(() => 0), 12);

    expect(s.line.startsWith('M0.0 64.0')).toBe(true);
    expect(s.line).toContain(`L${SPARK_WIDTH.toFixed(1)} ${SPARK_MID.toFixed(1)}`);
  });

  it('puts the peak at full reach above the middle', () => {
    // The scale is 1.25x the peak, so the peak itself lands at 0.8 of reach.
    const s = buildSparkline(series((h) => (h === 0 ? 10 : 0)), 0);

    expect(s.scale).toBe(12.5);
    expect(s.line.startsWith(`M0.0 ${(SPARK_MID - SPARK_REACH * 0.8).toFixed(1)}`)).toBe(true);
  });

  it('keeps a flat day flat instead of magnifying noise', () => {
    // Without a floor on the scale, a zone that never leaves ±50 MW would
    // fill the chart and read like a crisis.
    const s = buildSparkline(series(() => 0.05), 12);

    expect(s.scale).toBe(1.5);
    expect(s.line).not.toContain(`${(SPARK_MID - SPARK_REACH).toFixed(1)}`);
  });

  it('places the cursor on the selected hour', () => {
    const s = buildSparkline(series(() => 2), 12);

    expect(s.cursor).not.toBeNull();
    expect(s.cursor?.x).toBeCloseTo((12 / 23) * SPARK_WIDTH, 5);
  });

  it('has no cursor on an hour with no reading', () => {
    const s = buildSparkline(series((h) => (h === 7 ? null : 1)), 7);

    expect(s.cursor).toBeNull();
  });

  it('breaks the line at a gap rather than drawing through zero', () => {
    // A zone that published nothing at 03:00 did not publish zero, and a line
    // dipping to the axis and back is a claim the data does not make.
    const s = buildSparkline(series((h) => (h === 3 ? null : 2)), 0);
    const subpaths = s.line.split('M').filter(Boolean);

    expect(subpaths).toHaveLength(2);
  });

  it('closes each run of the area to the zero line', () => {
    const s = buildSparkline(series((h) => (h === 3 ? null : 2)), 0);

    expect(s.area.match(/Z/g)).toHaveLength(2);
  });

  it('reports an entirely missing series as empty', () => {
    const s = buildSparkline(new Array<number | null>(24).fill(null), 12);

    expect(s.empty).toBe(true);
    expect(s.line).toBe('');
    expect(s.cursor).toBeNull();
  });

  it('handles a single isolated reading', () => {
    const s = buildSparkline(series((h) => (h === 5 ? 3 : null)), 5);

    expect(s.empty).toBe(false);
    expect(s.cursor).not.toBeNull();
    expect(s.area).toContain('Z');
  });

  it('draws a negative value below the middle', () => {
    const s = buildSparkline(series(() => -5), 0);
    const firstY = Number(s.line.slice(1).split(' ')[1]);

    expect(firstY).toBeGreaterThan(SPARK_MID);
  });

  it('clamps an out-of-range hour instead of returning NaN', () => {
    expect(buildSparkline(series(() => 1), 99).cursor?.x).toBeDefined();
  });
});

describe('buildSparkline runs', () => {
  // The runs exist so a draw-on animation can reveal the line left to right.
  // A dash-offset sweep over the joined path measures progress by geometric
  // length, and the invisible jump across a gap costs no length — so the reveal
  // would teleport over a hole. One path per run, each given the slice of time
  // its own hours occupy, spends real time on the gap instead.
  it('is one run for a day with no gaps, spanning the whole day', () => {
    const s = buildSparkline(series(() => 2), 12);

    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ startHour: 0, endHour: 23 });
  });

  it('splits into one run per stretch of readings, with the hours they cover', () => {
    const s = buildSparkline(series((h) => (h >= 4 && h <= 6 ? null : 2)), 0);

    expect(s.runs.map((r) => [r.startHour, r.endHour])).toEqual([[0, 3], [7, 23]]);
  });

  it('keeps a single-reading run, which has a column of area but no line', () => {
    const s = buildSparkline(series((h) => (h === 5 ? 3 : null)), 5);

    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ startHour: 5, endHour: 5 });
  });

  it('draws exactly what the joined paths draw, so static and animated agree', () => {
    const s = buildSparkline(series((h) => (h === 9 ? null : 4)), 0);

    expect(s.runs.map((r) => r.d).join(' ')).toBe(s.line);
    expect(s.runs.map((r) => r.areaD).join(' ')).toBe(s.area);
  });

  it('has no runs when there is nothing to draw', () => {
    expect(buildSparkline(new Array<number | null>(24).fill(null), 12).runs).toEqual([]);
  });
});
