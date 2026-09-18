import { describe, it, expect } from 'vitest';
import { buildFlowRows, flowTotals, MAX_FLOW_ROWS } from './flowsPanel';
import { series } from './testFixture';

const FLOWS = {
  'DE-FR': series(() => 1_500),
  'CH-DE': series(() => 400),
  'DE-PL': series((h) => (h === 3 ? null : -200)),
  'AT-CH': series(() => 900),
};

describe('buildFlowRows', () => {
  it('signs every border from the selected zone point of view', () => {
    // The payload keys are alphabetical; the panel is about one country, so
    // positive means that country is exporting on that border.
    const rows = buildFlowRows(FLOWS, 'DE', 12);
    const byOther = Object.fromEntries(rows.map((r) => [r.other, r.mw]));

    expect(byOther.FR).toBe(1_500);
    expect(byOther.CH).toBe(-400);
    expect(byOther.PL).toBe(-200);
  });

  it('gives the neighbour the mirror-image figure', () => {
    expect(buildFlowRows(FLOWS, 'FR', 12)[0].mw).toBe(-1_500);
  });

  it('omits borders the zone is not on', () => {
    expect(buildFlowRows(FLOWS, 'DE', 12).map((r) => r.other)).not.toContain('AT');
  });

  it('sorts by magnitude, biggest first', () => {
    expect(buildFlowRows(FLOWS, 'DE', 12).map((r) => r.other)).toEqual(['FR', 'CH', 'PL']);
  });

  it('names the neighbour where the registry knows it', () => {
    expect(buildFlowRows(FLOWS, 'DE', 12)[0].label).toBe('France');
  });

  it('falls back to the code for a zone outside the registry', () => {
    const rows = buildFlowRows({ 'DE-XK': series(() => 100) }, 'DE', 12);

    expect(rows[0].label).toBe('XK');
  });

  it('drops an hour with no published flow rather than showing zero', () => {
    const rows = buildFlowRows(FLOWS, 'DE', 3);

    expect(rows.map((r) => r.other)).toEqual(['FR', 'CH']);
  });

  it('caps the list at seven borders', () => {
    const many: Record<string, (number | null)[]> = {};
    for (let i = 0; i < 12; i++) {
      many[`DE-Z${i}`] = series(() => 100 + i);
    }

    expect(buildFlowRows(many, 'DE', 12)).toHaveLength(MAX_FLOW_ROWS);
  });

  it('is empty with no zone selected', () => {
    expect(buildFlowRows(FLOWS, null, 12)).toEqual([]);
  });

  it('flags direction for the arrow glyph', () => {
    const rows = buildFlowRows(FLOWS, 'DE', 12);

    expect(rows.find((r) => r.other === 'FR')?.exporting).toBe(true);
    expect(rows.find((r) => r.other === 'CH')?.exporting).toBe(false);
  });
});

describe('flowTotals', () => {
  it('splits exports from imports and nets them', () => {
    const totals = flowTotals(FLOWS, 'DE', 12);

    expect(totals).toEqual({ exported: 1_500, imported: 600, net: 900 });
  });

  it('counts every border, not only the seven the panel lists', () => {
    const many: Record<string, (number | null)[]> = {};
    for (let i = 0; i < 12; i++) many[`DE-Z${i}`] = series(() => 100);

    expect(flowTotals(many, 'DE', 12)?.exported).toBe(1_200);
  });

  it('is null when nothing was published', () => {
    expect(flowTotals({}, 'DE', 12)).toBeNull();
    expect(flowTotals(FLOWS, null, 12)).toBeNull();
  });
});
