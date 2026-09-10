import { escapeHtml } from '../changelog/changelogHtml.js';

/**
 * The subset of Markdown the published OpenAPI document actually uses, and
 * nothing else.
 *
 * ## Why this exists at all
 *
 * `description` is a Markdown field in OpenAPI, and `spec.ts` writes it as
 * Markdown: 149 of the artifact's strings carry a code span and 45 carry a bold
 * run. Rendered as escaped plain text they would read `` `meta.coverage` `` and
 * `**exclusive**` on the page — the emphasis that tells an integrator which half
 * of a half-open window is which, printed as punctuation. Rendered by
 * `marked`, `markdown-it` or `remark` they would read correctly and this module
 * would be the sixth runtime dependency on a surface that hand-rolled its HTML
 * escaper rather than take a fifth.
 *
 * ## Why it is a whitelist rather than a parser
 *
 * The same argument `openapi/schemaCheck.ts` makes about validation keywords,
 * pointed at markup: **a construct this renderer does not implement must fail
 * loudly, not pass through as text.** A general parser degrades gracefully,
 * which here means a heading silently arriving as a paragraph, or a link's URL
 * printed inside its own brackets — on the page an integrator is asked to trust
 * as the contract. So the grammar is four productions, `renderBlocks` throws on
 * anything else, and `docsSite.test.ts` renders every string in the real
 * artifact through it. A construct nobody planned for is a build failure that
 * names the string, at the moment it is introduced.
 *
 * The four: paragraphs, `### headings`, `1.` ordered lists, and inline
 * `` `code` ``/`**strong**`/`*em*`. Links are deliberately not among them — see
 * `renderBlocks`.
 */

/**
 * A code span, matched before anything else so its contents are inert.
 *
 * `AccuracyRow.smape`'s description contains `` `100 * mean(|a - f| / (|a| +
 * |f|))` `` — an asterisk inside a code span that emphasis must not see. Running
 * emphasis first would eat it and everything up to the next asterisk in the
 * paragraph, silently changing a published formula. Code first is not a
 * preference about precedence; it is the only order that leaves that string
 * intact.
 */
const CODE_SPAN = /`([^`]*)`/g;

const STRONG = /\*\*([^*]+)\*\*/g;
const EMPHASIS = /\*([^*]+)\*/g;

const HEADING_LINE = /^(#{1,6})\s+(.*)$/;
const ORDERED_ITEM = /^\d+\.\s+(.*)$/;

/**
 * The one heading depth the published document uses.
 *
 * `info.description` and the accuracy operation's description both use `###`,
 * and nothing uses any other depth. See {@link renderBlocks} for why a second
 * one is a failure rather than a fallback.
 */
export const EXPECTED_HEADING_DEPTH = 3;

/** The deepest heading HTML has. */
const MAX_HEADING_LEVEL = 6;

export class UnsupportedMarkdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedMarkdownError';
  }
}

/**
 * `**bold**` and `*em*` over already-escaped text.
 *
 * Escaping happens first and the replacements insert their capture literally,
 * so a description containing `<` cannot reach the output as markup by way of
 * an emphasis run.
 */
function renderEmphasis(text: string): string {
  return escapeHtml(text)
    .replace(STRONG, '<strong>$1</strong>')
    .replace(EMPHASIS, '<em>$1</em>');
}

/**
 * One line of prose to one line of HTML.
 *
 * An unpaired asterisk or backtick stays literal rather than opening a run that
 * swallows the rest of the line. That is the one place this renderer is lenient,
 * and deliberately: the alternative is refusing to publish the contract over a
 * typo in a sentence that would still have read correctly.
 */
export function renderInline(text: string): string {
  let out = '';
  let cursor = 0;

  CODE_SPAN.lastIndex = 0;
  for (let match = CODE_SPAN.exec(text); match !== null; match = CODE_SPAN.exec(text)) {
    out += renderEmphasis(text.slice(cursor, match.index));
    out += `<code>${escapeHtml(match[1])}</code>`;
    cursor = match.index + match[0].length;
  }

  return out + renderEmphasis(text.slice(cursor));
}

/**
 * A Markdown description to block-level HTML.
 *
 * @param markdown  The description as written in `spec.ts`.
 * @param headingLevel  The level a `###` in this description renders at. The
 *   caller knows where the description sits in the page's outline; the
 *   description does not, and a heading that jumps a level is the specific
 *   defect a screen-reader user navigating by heading hits.
 * @param indent  Leading whitespace for each emitted line, so the served page
 *   stays readable in View Source. Cosmetic, and the only thing here that is.
 *
 * ## Two refusals
 *
 * **A heading at any depth other than `###` throws.** Every heading in the
 * document today is a `###`, and this renders it at the level the caller
 * nominated. A `####` would have to nest one deeper — but "one deeper than what"
 * is a question about the *page*, and clamping it to the same level instead
 * would flatten two distinct sections into one heading level, which is invisible
 * on screen and wrong in the outline a screen reader builds. The author of the
 * `####` is the person who knows what they meant by it; failing here puts the
 * question in front of them instead of guessing.
 *
 * **A link throws.** `[text](url)` is the construct that would let a `spec.ts`
 * description put an arbitrary URL on this site, and Constraint 1 is a rule
 * about exactly that: a URL to a font, a widget or an unpublished terms draft.
 * The artifact contains no link today, and `publishGuard.ts` independently
 * refuses absolute URLs anywhere in the document — this is the same rule caught
 * one layer earlier, where the error can name the description it came from.
 */
export function renderBlocks(
  markdown: string,
  { headingLevel, indent = '' }: { headingLevel: number; indent?: string }
): string {
  const source = markdown.replace(/\r\n/g, '\n').trim();
  if (source === '') return '';

  assertNoLinks(source);

  const level = Math.min(headingLevel, MAX_HEADING_LEVEL);
  const lines: string[] = [];

  for (const block of source.split(/\n{2,}/)) {
    const blockLines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (blockLines.length === 0) continue;

    const heading = HEADING_LINE.exec(blockLines[0]);
    if (heading) {
      if (blockLines.length > 1) {
        throw new UnsupportedMarkdownError(
          `a heading block carries ${blockLines.length - 1} extra line(s); ` +
            `separate a heading from its prose with a blank line: ${JSON.stringify(block)}`
        );
      }
      if (heading[1].length !== EXPECTED_HEADING_DEPTH) {
        throw new UnsupportedMarkdownError(
          `heading depth ${heading[1].length} is not rendered; the published document uses ` +
            `only '${'#'.repeat(EXPECTED_HEADING_DEPTH)}', and a second depth needs a decision ` +
            `about how it nests under the page's own headings rather than a default: ` +
            JSON.stringify(blockLines[0])
        );
      }
      lines.push(`${indent}<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (blockLines.every((line) => ORDERED_ITEM.test(line))) {
      lines.push(`${indent}<ol>`);
      for (const line of blockLines) {
        const item = ORDERED_ITEM.exec(line) as RegExpExecArray;
        lines.push(`${indent}  <li>${renderInline(item[1])}</li>`);
      }
      lines.push(`${indent}</ol>`);
      continue;
    }

    if (blockLines.some((line) => ORDERED_ITEM.test(line))) {
      throw new UnsupportedMarkdownError(
        `a block mixes list items with prose, which would render the items as one ` +
          `run-on paragraph: ${JSON.stringify(block)}`
      );
    }

    lines.push(`${indent}<p>${renderInline(blockLines.join(' '))}</p>`);
  }

  return lines.join('\n');
}

const MARKDOWN_LINK = /\[[^\]]*\]\([^)]*\)/;

function assertNoLinks(source: string): void {
  const match = MARKDOWN_LINK.exec(source);
  if (match === null) return;
  throw new UnsupportedMarkdownError(
    `a Markdown link is not rendered: ${JSON.stringify(match[0])}. A description is where an ` +
      `arbitrary URL would enter this site, which is what ABL-522 Constraint 1 forbids; if the ` +
      `target is a page of this site, say so in prose and let the reader find it in the index.`
  );
}
