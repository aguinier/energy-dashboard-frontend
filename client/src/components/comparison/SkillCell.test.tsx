import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { SkillCell } from './SkillCell';

/**
 * Renders the real component to HTML — no DOM needed, so this runs in the
 * default node environment. The three states this cell must never confuse
 * (a win, a loss, insufficient data) are ultimately a rendering question: a
 * loss that is only distinguished by colour fails ABL-186's "unmistakable"
 * bar for a reader who cannot see colour.
 */
describe('SkillCell', () => {
  it('marks a loss with more than colour: a visible down-marker and screen-reader text', () => {
    const html = renderToString(<SkillCell skill={{ n: 4, skillPct: -500, baselineWape: 1.59 }} />);
    expect(html).toContain('-500.0%');
    expect(html).toContain('▼');
    expect(html).toContain('worse than the D-7 naive baseline');
    expect(html).toContain('n=4');
  });

  it('renders a win without the down-marker or failure wording', () => {
    const html = renderToString(<SkillCell skill={{ n: 12, skillPct: 23.4, baselineWape: 5.1 }} />);
    expect(html).toContain('+23.4%');
    expect(html).not.toContain('▼');
    expect(html).not.toContain('worse than');
  });

  it('renders an explicit insufficient-data state, never a dash or 0%', () => {
    const html = renderToString(<SkillCell skill={{ n: 0, skillPct: null, baselineWape: null }} />);
    expect(html).toContain('insufficient data');
    expect(html).not.toContain('0.0%');
  });

  it('renders insufficient data for a stale response missing the field entirely', () => {
    const html = renderToString(<SkillCell skill={undefined} />);
    expect(html).toContain('insufficient data');
  });

  it('omits the pair count in compact mode but keeps it in the title for a hover/long-press', () => {
    const html = renderToString(<SkillCell skill={{ n: 7, skillPct: 10, baselineWape: 4 }} compact />);
    expect(html).not.toContain('n=7</span>');
    expect(html).toContain('n=7 pairs');
  });
});
