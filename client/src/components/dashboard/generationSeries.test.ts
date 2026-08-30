import { describe, it, expect } from 'vitest';
import type { GenerationSeriesPoint } from '@/types';
import { stackExtent } from '@/lib/divergingStack';
import {
  buildGenerationMixSeries,
  pointTotal,
  describeNegativeGroups,
  describeGenerationGaps,
  GENERATION_GROUP_ORDER,
  GENERATION_GROUP_COLORS,
  GENERATION_GROUP_LABELS,
  STORAGE_GROUPS,
} from './generationSeries';
import type { GenerationMixPoint, GenerationGroupKey } from './generationSeries';

/** A wire point with everything null unless named. */
function point(timestamp: string, over: Partial<GenerationSeriesPoint> = {}): GenerationSeriesPoint {
  return {
    timestamp,
    nuclear: null, solar: null, wind: null, hydro: null, hydro_pumped: null,
    fossil: null, biomass: null, waste: null, other: null,
    ...over,
  };
}

describe('group metadata', () => {
  it('gives every group in the stack order a label and a colour', () => {
    for (const key of GENERATION_GROUP_ORDER) {
      expect(GENERATION_GROUP_LABELS[key]).toBeTruthy();
      expect(GENERATION_GROUP_COLORS[key]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    expect(new Set(GENERATION_GROUP_ORDER).size).toBe(GENERATION_GROUP_ORDER.length);
  });

  it('stacks the storage groups adjacent to the zero baseline', () => {
    // Load-bearing, not cosmetic: these are the groups that flip sign (FR's
    // `other` 144 times in a week at 15-minute resolution), and in a diverging
    // stack a flip moves the band by whatever is stacked beneath it. Ordered
    // last, each flip drew a full-height vertical sliver across France's
    // 64 GW stack. Ordered first, it pivots about the baseline it already
    // touches.
    expect(GENERATION_GROUP_ORDER.slice(0, STORAGE_GROUPS.length)).toEqual([...STORAGE_GROUPS]);
  });

  it('keeps the four families the donut colours green contiguous', () => {
    const renewables = ['solar', 'wind', 'hydro', 'biomass'];
    const at = renewables.map((k) => GENERATION_GROUP_ORDER.indexOf(k as never));

    expect(Math.max(...at) - Math.min(...at)).toBe(renewables.length - 1);
  });
});

describe('buildGenerationMixSeries', () => {
  const NOW = new Date('2026-07-01T04:00:00Z');

  it('draws the classical families alongside the renewables', () => {
    const series = buildGenerationMixSeries(
      [point('2026-07-01T00:00:00', { solar: 100, wind: 200, nuclear: 300, fossil: 400 })],
      NOW,
    );

    expect(series.groups).toEqual(['solar', 'wind', 'nuclear', 'fossil']);
    expect(series.points[0].values.nuclear).toBe(300);
    expect(series.points[0].values.fossil).toBe(400);
  });

  it('leaves out a group this country never reports, rather than drawing a zero band', () => {
    // The PT shape. A zero-height band under a legend swatch claims the
    // country generates none of something; the truth is we were not told.
    const series = buildGenerationMixSeries(
      [
        point('2026-07-01T00:00:00', { solar: 10 }),
        point('2026-07-01T01:00:00', { solar: 12 }),
      ],
      NOW,
    );

    expect(series.groups).toEqual(['solar']);
    expect(series.groups).not.toContain('nuclear');
  });

  it('returns no groups at all when every group is null at every point', () => {
    const series = buildGenerationMixSeries(
      [point('2026-07-01T00:00:00'), point('2026-07-01T01:00:00')],
      NOW,
    );

    expect(series.points).toHaveLength(2);
    expect(series.groups).toEqual([]);
  });

  it('keeps a group whose only readings are a measured zero', () => {
    // BE's overnight solar. Zero is a measurement; it is not the same answer
    // as "not reported", and the band (flat on the baseline) is correct.
    const series = buildGenerationMixSeries(
      [point('2026-07-01T00:00:00', { solar: 0 }), point('2026-07-01T01:00:00', { solar: 0 })],
      NOW,
    );

    expect(series.groups).toEqual(['solar']);
    expect(series.points[0].values.solar).toBe(0);
  });

  it('keeps a hole inside an otherwise-reported group as null, not zero', () => {
    const series = buildGenerationMixSeries(
      [
        point('2026-07-01T00:00:00', { solar: 10 }),
        point('2026-07-01T01:00:00'),
        point('2026-07-01T02:00:00', { solar: 30 }),
      ],
      NOW,
    );

    expect(series.groups).toEqual(['solar']);
    expect(series.points[1].values.solar).toBeNull();
  });

  it('flags the groups that go negative', () => {
    const series = buildGenerationMixSeries(
      [point('2026-07-01T00:00:00', { nuclear: 700, hydro_pumped: -300, fossil: -50 })],
      NOW,
    );

    // Reported in stack order, so the caption names them bottom-up.
    expect(series.negativeGroups).toEqual(['hydroPumped', 'fossil']);
    expect(series.points[0].values.hydroPumped).toBe(-300);
  });

  it('does not flag a group that only touches zero', () => {
    const series = buildGenerationMixSeries(
      [point('2026-07-01T00:00:00', { hydro_pumped: 0, solar: 5 })],
      NOW,
    );

    expect(series.negativeGroups).toEqual([]);
  });

  it('marks the last non-future point as now', () => {
    const series = buildGenerationMixSeries(
      [
        point('2026-07-01T00:00:00', { solar: 1 }),
        point('2026-07-01T01:00:00', { solar: 2 }),
        point('2026-07-01T09:00:00', { solar: 3 }),
      ],
      NOW,
    );

    expect(series.nowIndex).toBe(1);
  });

  it('renders every hourly bucket in a Today window without admitting tomorrow', () => {
    const series = buildGenerationMixSeries(
      [
        point('2026-07-01T00:00:00Z', { solar: 10 }),
        point('2026-07-01T12:00:00Z', { solar: 20 }),
        point('2026-07-02T00:00:00Z', { solar: 99 }),
      ],
      new Date('2026-07-01T12:30:00Z'),
      {
        start: new Date('2026-07-01T00:00:00Z'),
        end: new Date('2026-07-01T23:59:59.999Z'),
      },
    );

    expect(series.points).toHaveLength(24);
    expect(series.points[0].ts).toBe('2026-07-01T00:00:00Z');
    expect(series.points[23].ts).toBe('2026-07-01T23:00:00.000Z');
    expect(series.points[12].values.solar).toBe(20);
    expect(series.points[13].values.solar).toBeNull();
    expect(series.points.some((p) => p.values.solar === 99)).toBe(false);
  });

  it('is empty for no data', () => {
    expect(buildGenerationMixSeries(undefined, NOW).points).toEqual([]);
    expect(buildGenerationMixSeries([], NOW).groups).toEqual([]);
  });
});

describe('the series feeds the diverging stack correctly', () => {
  // The stack math itself is `lib/divergingStack.ts` (with its own test); what
  // matters here is that this builder hands it a domain that reaches below
  // zero exactly when a group really goes negative.
  it('leaves the axis at zero for a country that never pumps', () => {
    const series = buildGenerationMixSeries([
      point('2026-07-01T00:00:00', { solar: 100, nuclear: 300 }),
      point('2026-07-01T01:00:00', { solar: 150, nuclear: 300 }),
    ]);

    expect(stackExtent(series.points, series.groups)).toEqual({ min: 0, max: 450 });
  });

  it('extends below zero by the deepest negative total', () => {
    const series = buildGenerationMixSeries([
      point('2026-07-01T00:00:00', { solar: 100, nuclear: 300, hydro_pumped: -200 }),
      point('2026-07-01T01:00:00', { solar: 100, nuclear: 300, hydro_pumped: -500 }),
    ]);

    expect(stackExtent(series.points, series.groups)).toEqual({ min: -500, max: 400 });
  });

  it('does not let an unreported group widen the domain', () => {
    // PT: a group that is null throughout is not in `groups`, so it cannot
    // contribute a zero band to the extent either.
    const series = buildGenerationMixSeries([
      point('2026-07-01T00:00:00', { solar: 100 }),
    ]);

    expect(series.groups).toEqual(['solar']);
    expect(stackExtent(series.points, series.groups)).toEqual({ min: 0, max: 100 });
  });
});

describe('pointTotal', () => {
  it('nets the negatives against the positives', () => {
    const [p] = buildGenerationMixSeries([
      point('2026-07-01T00:00:00', { nuclear: 700, hydro_pumped: -300 }),
    ]).points;

    expect(pointTotal(p, ['nuclear', 'hydroPumped'])).toBe(400);
  });

  it('is null when nothing was reported at this point, never a confident zero', () => {
    const [p] = buildGenerationMixSeries([
      point('2026-07-01T00:00:00', { solar: 5 }),
      point('2026-07-01T01:00:00'),
    ]).points.slice(1);

    expect(pointTotal(p, ['solar'])).toBeNull();
  });

  it('is zero when a measured zero is all there is', () => {
    const [p] = buildGenerationMixSeries([point('2026-07-01T00:00:00', { solar: 0 })]).points;

    expect(pointTotal(p, ['solar'])).toBe(0);
  });
});

describe('describeNegativeGroups', () => {
  it('says nothing when nothing is below the line', () => {
    expect(describeNegativeGroups([])).toBeNull();
  });

  it('names one group', () => {
    const note = describeNegativeGroups(['hydroPumped'])!;

    expect(note).toContain('Pumped storage is negative');
    expect(note).toContain('below the zero line');
  });

  it('names several', () => {
    expect(describeNegativeGroups(['fossil', 'hydroPumped'])).toContain(
      'Fossil and Pumped storage are negative',
    );
  });
});

// Every group reports 1 MW unless a test overrides it — isolates the one
// group under test from the "absent throughout" case the other groups would
// otherwise also trigger.
const BASELINE = Object.fromEntries(GENERATION_GROUP_ORDER.map((k) => [k, 1])) as Record<
  GenerationGroupKey,
  number
>;

/** A fully-reported past point, with the named overrides (`null` punches a hole). */
function pastPoint(over: Partial<Record<GenerationGroupKey, number | null>> = {}): GenerationMixPoint {
  return { ts: '2026-07-01T00:00:00Z', future: false, values: { ...BASELINE, ...over } };
}

/** A future point — null for every group, the way `buildGenerationMixSeries`'s grid-fill pads a Today window past "now". */
function futurePoint(): GenerationMixPoint {
  const values = Object.fromEntries(GENERATION_GROUP_ORDER.map((k) => [k, null])) as Record<
    GenerationGroupKey,
    number | null
  >;
  return { ts: '2026-07-01T00:00:00Z', future: true, values };
}

describe('describeGenerationGaps', () => {
  it('says nothing for an empty window', () => {
    expect(describeGenerationGaps([])).toBeNull();
  });

  it('says nothing when every group reports at every past point', () => {
    expect(describeGenerationGaps([pastPoint(), pastPoint()])).toBeNull();
  });

  it('names a group absent for the whole window', () => {
    // nuclear_mw NULL for all 24 hours, the exact case ABL's verified facts
    // cite for 2026-08-28.
    const points = [pastPoint({ nuclear: null }), pastPoint({ nuclear: null })];

    expect(describeGenerationGaps(points)).toBe('Nuclear absent for all 2 plotted points.');
  });

  it('names a group with an interior hole, distinctly from full absence', () => {
    const points = [pastPoint(), pastPoint({ solar: null }), pastPoint()];

    expect(describeGenerationGaps(points)).toBe('Solar unpublished for 1 of 3 plotted points.');
  });

  it('combines several groups in one sentence, in stack order', () => {
    const points = [pastPoint({ solar: null }), pastPoint({ nuclear: null })];

    // Solar precedes Nuclear in GENERATION_GROUP_ORDER, and each is null at
    // exactly one of the two points — a partial gap for both, not a full
    // absence for either.
    expect(describeGenerationGaps(points)).toBe(
      'Solar unpublished for 1 of 2 plotted points; Nuclear unpublished for 1 of 2 plotted points.',
    );
  });

  it('never counts an unelapsed future point as a gap', () => {
    // A Today window pads every group with null past "now" (buildGenerationMixSeries's
    // grid-fill) — that is not a data hole and must never read as one.
    const points = [pastPoint(), pastPoint(), futurePoint(), futurePoint()];

    expect(describeGenerationGaps(points)).toBeNull();
  });

  it('still reports a genuine past hole even with a future tail', () => {
    const points = [pastPoint(), pastPoint({ solar: null }), futurePoint(), futurePoint()];

    expect(describeGenerationGaps(points)).toBe('Solar unpublished for 1 of 2 plotted points.');
  });
});
