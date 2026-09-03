import { describe, it, expect } from 'vitest';
import { UnsupportedMarkdownError, renderBlocks, renderInline } from './markdown.js';

/**
 * The renderer is a whitelist, so most of these are **rejections**.
 *
 * Same shape as `openapi/schemaCheck.test.ts`, and for the same reason: a
 * renderer that quietly passes an unimplemented construct through as text is a
 * renderer that has stopped rendering while every test still passes. The
 * assertions that matter here are the ones proving it refuses.
 */

describe('inline', () => {
  it('does not let emphasis reach inside a code span', () => {
    // AccuracyRow.smape's real description. Running emphasis before code spans
    // would eat from the first `*` to the next one and change a published
    // formula into markup — silently, in the one place a reader will copy the
    // text out verbatim.
    const source = 'defined as `100 * mean(|a - f| / (|a| + |f|))`. Note *that*.';
    const html = renderInline(source);

    expect(html).toContain('<code>100 * mean(|a - f| / (|a| + |f|))</code>');
    expect(html).toContain('<em>that</em>');
  });

  it('escapes HTML inside a code span', () => {
    // The API key description carries `Bearer able_live_<prefix>_<secret>`.
    expect(renderInline('`Bearer able_live_<prefix>_<secret>`')).toBe(
      '<code>Bearer able_live_&lt;prefix&gt;_&lt;secret&gt;</code>'
    );
  });

  it('escapes HTML outside a code span before applying emphasis', () => {
    expect(renderInline('**<b>bold</b>**')).toBe('<strong>&lt;b&gt;bold&lt;/b&gt;</strong>');
  });

  it('reads ** as strong and * as em, in that order', () => {
    expect(renderInline('**start** of *each* interval')).toBe(
      '<strong>start</strong> of <em>each</em> interval'
    );
  });

  it('leaves an unpaired marker alone rather than opening a run', () => {
    expect(renderInline('2 * 3 is six')).toBe('2 * 3 is six');
    expect(renderInline('a lone ` backtick')).toBe('a lone ` backtick');
  });
});

describe('blocks', () => {
  it('renders a heading at the level the caller nominated', () => {
    expect(renderBlocks('### Four rules', { headingLevel: 2 })).toBe('<h2>Four rules</h2>');
    expect(renderBlocks('### Four rules', { headingLevel: 4 })).toBe('<h4>Four rules</h4>');
  });

  it('renders an ordered list as one', () => {
    expect(renderBlocks('1. First thing\n2. Second thing', { headingLevel: 2 })).toBe(
      ['<ol>', '  <li>First thing</li>', '  <li>Second thing</li>', '</ol>'].join('\n')
    );
  });

  it('joins a wrapped paragraph onto one line', () => {
    expect(renderBlocks('one\ntwo', { headingLevel: 2 })).toBe('<p>one two</p>');
  });

  it('separates blocks on a blank line', () => {
    expect(renderBlocks('one\n\ntwo', { headingLevel: 2 })).toBe('<p>one</p>\n<p>two</p>');
  });

  it('indents every emitted line by the caller’s indent', () => {
    expect(renderBlocks('one', { headingLevel: 2, indent: '    ' })).toBe('    <p>one</p>');
  });

  it('is empty for an empty description rather than emitting an empty paragraph', () => {
    expect(renderBlocks('', { headingLevel: 2 })).toBe('');
    expect(renderBlocks('   \n\n  ', { headingLevel: 2 })).toBe('');
  });
});

describe('refusals', () => {
  it('refuses a heading depth it has not been told how to nest', () => {
    // Not clamped to the caller's level: two distinct sections rendered at one
    // heading level look identical on screen and give a screen reader a wrong
    // outline. The author of the `####` is the one who knows what they meant.
    expect(() => renderBlocks('#### Deeper', { headingLevel: 2 })).toThrow(
      UnsupportedMarkdownError
    );
    expect(() => renderBlocks('## Shallower', { headingLevel: 2 })).toThrow(
      UnsupportedMarkdownError
    );
  });

  it('refuses a Markdown link', () => {
    // The construct that would let a spec.ts description put an arbitrary URL
    // on this site, which is what ABL-522 Constraint 1 forbids.
    expect(() => renderBlocks('see [the terms](https://example.com/tos)', { headingLevel: 2 }))
      .toThrow(/Markdown link/);
  });

  it('refuses a heading with prose stuck to it', () => {
    // Would otherwise render the prose as part of the heading text.
    expect(() => renderBlocks('### Title\nand prose', { headingLevel: 2 })).toThrow(
      UnsupportedMarkdownError
    );
  });

  it('refuses a block that mixes list items with prose', () => {
    // Would otherwise collapse into one run-on paragraph containing "1." and
    // "2." as literal text, which reads as a formatting bug and is one.
    expect(() => renderBlocks('lead in\n1. first\n2. second', { headingLevel: 2 })).toThrow(
      UnsupportedMarkdownError
    );
  });

  it('names the offending source in the message', () => {
    // The person who has to fix this is editing spec.ts and has 181 descriptions
    // to choose from; a message that does not quote the string is a search.
    expect(() => renderBlocks('#### Deeper', { headingLevel: 2 })).toThrow(/#### Deeper/);
  });
});
