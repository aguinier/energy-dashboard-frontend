// @vitest-environment jsdom
//
// Component test needs a DOM; the rest of the suite is pure-module and runs in
// vitest's default node environment (see Figure.test.tsx for the same opt-in).
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AbleResidualStrip } from './AbleResidualStrip';

describe('AbleResidualStrip', () => {
  afterEach(() => cleanup());

  it('draws one bar per residual point', () => {
    const { container } = render(
      <AbleResidualStrip points={[
        { t: 'a', residual: 10 }, { t: 'b', residual: -5 }, { t: 'c', residual: 2 },
      ]} />
    );
    expect(container.querySelectorAll('rect[data-residual]')).toHaveLength(3);
  });

  it('signs the bars, so over- and under-forecast are distinguishable', () => {
    const { container } = render(
      <AbleResidualStrip points={[{ t: 'a', residual: 10 }, { t: 'b', residual: -5 }]} />
    );
    const bars = Array.from(container.querySelectorAll('rect[data-residual]'));
    expect(bars.map((b) => b.getAttribute('data-sign'))).toEqual(['over', 'under']);
  });

  it('renders nothing when there is nothing to show', () => {
    const { container } = render(<AbleResidualStrip points={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('states the peak magnitude so the strip has a scale', () => {
    render(<AbleResidualStrip points={[{ t: 'a', residual: 1234 }]} />);
    expect(screen.queryByText(/1,234/)).not.toBeNull();
  });
});
