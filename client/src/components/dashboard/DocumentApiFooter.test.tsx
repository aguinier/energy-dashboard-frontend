// @vitest-environment jsdom
//
// Component test needs a DOM; see Figure.test.tsx for the same opt-in.
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DocumentApiFooter } from './DocumentApiFooter';

describe('DocumentApiFooter', () => {
  afterEach(() => cleanup());

  // final-review-9, finding 2: figure 3 draws from `/generation/series` (it
  // needs nuclear and fossil bands, not only the renewable families — ABL-44),
  // so the endpoint this footer advertises for it must match, not the
  // narrower `/renewables` series the figure does not read.
  it('advertises the endpoint figure 3 actually reads, not the narrower renewables series', () => {
    render(<DocumentApiFooter />);
    const row = screen.getByText(/Fig\. 3/).closest('code');
    expect(row?.textContent).toContain('/api/generation/series');
    expect(row?.textContent).not.toContain('/api/renewables');
  });

  it('leaves every other figure pointed at its own endpoint', () => {
    render(<DocumentApiFooter />);
    expect(screen.getByText(/Fig\. 1/).closest('code')?.textContent).toContain('/api/load');
    expect(screen.getByText(/Fig\. 2/).closest('code')?.textContent).toContain('/api/prices');
    expect(screen.getByText(/Fig\. 4/).closest('code')?.textContent).toContain('/api/generation/wind');
    expect(screen.getByText(/Fig\. 5/).closest('code')?.textContent).toContain('/api/generation/wind');
    expect(screen.getByText(/Fig\. 6/).closest('code')?.textContent).toContain('/api/net-position/');
  });
});
