// @vitest-environment jsdom
//
// Component test needs a DOM; the rest of the suite is pure-module and runs in
// vitest's default node environment (see LoadTab.test.tsx for the same opt-in).
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AccuracyBadge } from './AccuracyBadge';

describe('AccuracyBadge', () => {
  afterEach(() => cleanup());

  it('quotes the WAPE with its denominator', () => {
    render(<AccuracyBadge metrics={{ wape: 3.42, mae: 210, dataPoints: 2976 }} window="30 days" />);
    expect(screen.queryByText(/3\.42%/)).not.toBeNull();
    expect(screen.queryByText(/2,976/)).not.toBeNull();
  });

  it('says the comparison is withheld, and does not say "not measurable"', () => {
    render(<AccuracyBadge metrics={{ wape: null, mae: null, dataPoints: 720 }} window="30 days" />);
    expect(screen.queryByText(/withheld/i)).not.toBeNull();
    expect(screen.queryByText(/not measurable/i)).toBeNull();
  });

  it('says not measurable when the window holds no usable comparison', () => {
    render(<AccuracyBadge metrics={{ wape: null, mae: null, dataPoints: 0 }} window="30 days" />);
    expect(screen.queryByText(/not measurable/i)).not.toBeNull();
  });

  it('renders nothing at all when no forecast exists for this series', () => {
    const { container } = render(<AccuracyBadge metrics={undefined} window="30 days" />);
    expect(container.innerHTML).toBe('');
  });

  it('never renders a bare percentage without a denominator', () => {
    render(<AccuracyBadge metrics={{ wape: 3.42, mae: 210, dataPoints: 4 }} window="30 days" />);
    expect(screen.queryByText(/3\.42%/)).toBeNull();
  });
});
