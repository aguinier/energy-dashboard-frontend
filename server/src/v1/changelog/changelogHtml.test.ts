import { describe, it, expect } from 'vitest';
import { escapeHtml, formatInstant, renderChangelogHtml } from './changelogHtml.js';
import type { ChangelogEntry } from './changelogEntry.js';

/**
 * What the page is allowed to contain, asserted against the bytes.
 *
 * Two of ABL-532's constraints are properties of the rendered output rather than
 * of the code that produced it — "nothing loads a third-party asset" and
 * "nothing links to or cites the Terms" — so both are checked here by reading the
 * string, not by trusting the module header that says so.
 */

const planned: ChangelogEntry = {
  id: 'cl_planned0001',
  type: 'planned',
  publishedAt: '2026-08-22T09:00:00.000Z',
  effectiveAt: '2026-09-21T09:00:00.000Z',
  title: 'Load forecast model replaced for three zones',
  detail: 'The model behind day-ahead load for AT, BE and CH is replaced.',
  whatWasWrong: null,
  isExample: false,
};

const fix: ChangelogEntry = {
  id: 'cl_fix00000001',
  type: 'correction',
  publishedAt: '2026-08-25T14:03:00.000Z',
  effectiveAt: '2026-08-25T14:03:00.000Z',
  title: 'Netherlands load forecast basis corrected',
  detail: 'Values are now served on the same basis as the published actuals.',
  whatWasWrong: 'Forecasts were served on a gross basis against net actuals for nine days.',
  isExample: false,
};

describe('the rendered page loads nothing', () => {
  const html = renderChangelogHtml([planned, fix]);

  it('has no script, stylesheet, image, frame or embedded object', () => {
    // The public app sends `default-src 'none'`, so a browser would refuse any
    // of these — but the header is the second lock, not the first. A stylesheet
    // appearing here is the moment somebody has to widen that header, which is
    // exactly how a template's analytics default arrives.
    for (const tag of ['<script', '<link', '<img', '<iframe', '<object', '<embed', '<svg']) {
      expect(html).not.toContain(tag);
    }
  });

  it('has no absolute URL of any scheme, and no protocol-relative one', () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\ssrc\s*=/);
    expect(html).not.toMatch(/@import/);
    // `//example.com` in an attribute. The fragment links the entries carry are
    // the only hrefs on the page, so anything with a `//` in an href is new.
    expect(html).not.toMatch(/href="(?!#)/);
  });

  it('has no inline style or event handler either', () => {
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\sstyle\s*=/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/);
  });
});

describe('the rendered page cites nothing it may not cite', () => {
  const html = renderChangelogHtml([planned, fix]);

  it('carries no clause citation', () => {
    // A clause number points a reader at a document they cannot open while
    // ABL-349 is holding publication, which is the same failure
    // GATED_INFO_FIELDS exists to prevent in the OpenAPI document.
    expect(html).not.toMatch(/§/);
    expect(html).not.toMatch(/\b(clause|section)\s*9\b/i);
  });

  it('does not name or link the subscriber terms', () => {
    const lower = html.toLowerCase();
    expect(lower).not.toContain('terms of service');
    expect(lower).not.toContain('terms and conditions');
  });

  it('still explains both dates and both types in its own words', () => {
    // The point of the rule above is not silence. A reader has to be able to act
    // on this page without holding the contract.
    expect(html).toContain('Published');
    expect(html).toContain('Effective');
    expect(html).toContain('30 days before it takes effect');
    expect(html).toContain('published at the same time');
    expect(html).toContain('what was wrong');
  });
});

describe('entries', () => {
  it('renders newest first, whatever order it is handed', () => {
    const html = renderChangelogHtml([planned, fix]);
    const reversed = renderChangelogHtml([fix, planned]);

    expect(html).toBe(reversed);
    expect(html.indexOf('cl_fix00000001')).toBeLessThan(html.indexOf('cl_planned0001'));
  });

  it('gives every entry both instants, machine-readable and human-readable', () => {
    const html = renderChangelogHtml([planned]);

    expect(html).toContain('<time datetime="2026-08-22T09:00:00.000Z">2026-08-22 09:00:00 UTC</time>');
    expect(html).toContain('<time datetime="2026-09-21T09:00:00.000Z">2026-09-21 09:00:00 UTC</time>');
  });

  it('states the notice each entry actually gave', () => {
    expect(renderChangelogHtml([planned])).toContain('30 days before the change takes effect');
    expect(renderChangelogHtml([fix])).toContain('published at the same time as the change');
  });

  it('labels the type and, on a correction, what was wrong', () => {
    const html = renderChangelogHtml([fix]);

    expect(html).toContain('<dd>Correction</dd>');
    expect(html).toContain('<strong>What was wrong:</strong> Forecasts were served on a gross');
  });

  it('does not print a "what was wrong" line on a planned change', () => {
    expect(renderChangelogHtml([planned])).not.toContain('What was wrong');
  });

  it('gives each entry a stable fragment id and a link to it', () => {
    const html = renderChangelogHtml([planned]);

    expect(html).toContain('<article id="cl_planned0001">');
    expect(html).toContain('href="#cl_planned0001"');
  });

  it('marks an example loudly, above the entry', () => {
    const html = renderChangelogHtml([{ ...planned, isExample: true }]);
    const marker = html.indexOf('EXAMPLE ENTRY');

    expect(marker).toBeGreaterThan(-1);
    expect(html).toContain('describes no real change and gives notice of nothing');
    // Above the detail, not tucked beside the metadata.
    expect(marker).toBeLessThan(html.indexOf(planned.detail));
  });

  it('says so plainly when there is nothing published', () => {
    const html = renderChangelogHtml([]);

    expect(html).toContain('No entries have been published yet.');
    expect(html).toContain('<h1>Model and data change log</h1>');
  });
});

describe('escaping', () => {
  it('escapes every character that could end a text node or an attribute', () => {
    expect(escapeHtml(`<b>&"'`)).toBe('&lt;b&gt;&amp;&quot;&#39;');
  });

  it('escapes the ampersand first, so an entity is not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('keeps operator prose out of the markup', () => {
    // Entry text is typed at a terminal, which makes it untrusted in the only
    // sense that matters here.
    const html = renderChangelogHtml([
      {
        ...planned,
        title: '<script>alert(1)</script>',
        detail: 'Values "dropped" & the model <changed>.',
        id: 'cl_x"><script>x',
      },
    ]);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Values &quot;dropped&quot; &amp; the model &lt;changed&gt;.');
    expect(html).toContain('id="cl_x&quot;&gt;&lt;script&gt;x"');
  });
});

describe('formatInstant', () => {
  it('is a slice, not a locale', () => {
    // The page has to be the same bytes on a laptop, in CI and on the host; a
    // locale-aware formatter makes it a function of the server's environment.
    expect(formatInstant('2026-09-21T09:00:00.000Z')).toBe('2026-09-21 09:00:00 UTC');
    expect(formatInstant('2026-01-01T00:00:00.000Z')).toBe('2026-01-01 00:00:00 UTC');
  });
});
