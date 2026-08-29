// @vitest-environment jsdom
//
// Component test needs a DOM; the rest of the suite is pure-module and runs in
// vitest's default node environment (see LoadTab.test.tsx for the same opt-in).
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Figure } from './Figure';

describe('Figure', () => {
  afterEach(() => cleanup());

  it('numbers the figure and renders its title, caption and plot', () => {
    render(
      <Figure number={1} anchorId="load" title="Electricity demand" caption="What it shows.">
        <div data-testid="plot" />
      </Figure>
    );
    expect(screen.queryByText('Figure 1')).not.toBeNull();
    expect(screen.queryByText('Electricity demand')).not.toBeNull();
    expect(screen.queryByText('What it shows.')).not.toBeNull();
    expect(screen.queryByTestId('plot')).not.toBeNull();
  });

  it('exposes an anchor id so a caller can be scrolled to this figure', () => {
    const { container } = render(
      <Figure number={2} anchorId="price" title="Price" caption="c"><div /></Figure>
    );
    expect(container.querySelector('#figure-price')).not.toBeNull();
  });

  it('renders the footnote inside the figcaption of a semantic figure', () => {
    const { container } = render(
      <Figure number={3} anchorId="mix" title="Mix" caption="c" footnote={<span>Nuclear absent</span>}>
        <div />
      </Figure>
    );
    expect(screen.getByRole('figure')).not.toBeNull();
    const figcaption = container.querySelector('figcaption');
    expect(figcaption).not.toBeNull();
    expect(figcaption?.textContent).toContain('Nuclear absent');
  });

  it('takes its accessible name from the title, not the figcaption footnote', () => {
    // A <figure> takes its accessible name from <figcaption> by default. If
    // that were still true here, this query — asking for a figure named after
    // its title — would find nothing, because the name would instead be the
    // footnote's provenance/badge text.
    render(
      <Figure
        number={1}
        anchorId="load"
        title="Electricity demand"
        caption="What it shows."
        footnote={<span>WAPE 3.33% over 30 days</span>}
      >
        <div />
      </Figure>
    );
    expect(screen.getByRole('figure', { name: 'Electricity demand' })).not.toBeNull();
  });

  it('associates the descriptive caption as the figure\'s accessible description', () => {
    const { container } = render(
      <Figure number={1} anchorId="load" title="Electricity demand" caption="What it shows.">
        <div />
      </Figure>
    );
    const figure = screen.getByRole('figure');
    const describedBy = figure.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(container.querySelector(`#${describedBy}`)?.textContent).toBe('What it shows.');
  });

  it('omits the footnote row entirely when there is no footnote', () => {
    const { container } = render(
      <Figure number={4} anchorId="wind" title="Wind" caption="c"><div /></Figure>
    );
    expect(container.querySelector('figcaption')).toBeNull();
  });
});
