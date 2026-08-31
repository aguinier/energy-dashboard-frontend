// @vitest-environment jsdom
//
// Component test needs a DOM; see Figure.test.tsx for the same opt-in.
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TsoAccuracyFootnote } from './TsoAccuracyFootnote';

describe('TsoAccuracyFootnote', () => {
  afterEach(() => cleanup());

  // final-review-9, finding 1: the footnote must never assert "not an able
  // model" while the chart it annotates is resolved to draw one.
  it('does not claim "not an able model" when an able-ml forecast is resolved', () => {
    render(<TsoAccuracyFootnote metrics={undefined} window="30 days" includesMl />);
    expect(screen.queryByText(/not an able model/i)).toBeNull();
  });

  it('says the drawn line is able-ml’s own when an able-ml forecast is resolved', () => {
    const { container } = render(<TsoAccuracyFootnote metrics={undefined} window="30 days" includesMl />);
    expect(container.textContent).toContain('able-ml');
    expect(container.textContent).toContain('badge and');
  });

  it('keeps the original TSO claim when no able-ml forecast is resolved', () => {
    render(<TsoAccuracyFootnote metrics={undefined} window="30 days" includesMl={false} />);
    expect(screen.queryByText(/not an able model/i)).not.toBeNull();
  });

  it('still renders the accuracy badge alongside either footnote', () => {
    const { container } = render(
      <TsoAccuracyFootnote
        metrics={{ wape: 3.42, mae: 100, dataPoints: 720 }}
        window="30 days"
        includesMl={false}
      />
    );
    expect(container.textContent).toContain('WAPE 3.42%');
  });
});
