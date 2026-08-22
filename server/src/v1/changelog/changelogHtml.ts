import {
  NOTICE_PERIOD_DAYS,
  describeNotice,
  sortEntriesNewestFirst,
  type ChangelogEntry,
} from './changelogEntry.js';

/**
 * The change-log page, as one string.
 *
 * ## It loads nothing
 *
 * No stylesheet, no script, no font, no image, no favicon — not even a same-origin
 * one. That is not austerity for its own sake, and it is not a style preference:
 *
 * - **It is what makes ABL-522 Constraint 1 machine-enforced.** The public app
 *   already sends `Content-Security-Policy: default-src 'none'`
 *   (`publicApp.ts`), so a browser will *refuse* any subresource a future edit
 *   adds here. Adding CSS would mean widening that header, and the header is the
 *   only reason "no third-party analytics, fonts or scripts" is a property of the
 *   deployment rather than a promise about what we remembered not to paste in.
 * - **A default that arrives with a template still counts as a violation**, and
 *   the way templates arrive is that somebody wants the page to look nicer. There
 *   is no template here to bring one.
 * - Semantic HTML with browser default styling is legible. Headings, a
 *   description list per entry and `<time>` elements carry the structure a reader
 *   and a screen reader both need.
 *
 * ## It cites nothing
 *
 * No link to the subscriber terms and no clause number anywhere in the output.
 * `GATED_INFO_FIELDS` (`v1/openapi/spec.ts`) withholds `termsOfService` while
 * ABL-349 is open, and a page that linked or cited them would reintroduce exactly
 * what that gate prevents — a reader pointed at a document they cannot open. The
 * two entry types and the two dates are therefore explained here **in the page's
 * own words**, which a reader can act on without holding the contract.
 *
 * `changelogHtml.test.ts` asserts both properties against the rendered string
 * rather than against this comment.
 */

/**
 * Every character that can end an HTML text node or an attribute value.
 *
 * Entry prose is typed by an operator at a terminal, so it is untrusted input in
 * the only sense that matters here: a title containing `<` must not become
 * markup. Hand-rolled for the reason the rest of this surface hand-rolls things —
 * a templating library would be a sixth runtime dependency for one function.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * `2026-09-21T09:00:00.000Z` → `2026-09-21 09:00:00 UTC`.
 *
 * Sliced rather than formatted through `Intl` or `toLocaleString`: the rendered
 * page must be the same bytes on the operator's laptop, in CI and on the host,
 * and a locale-aware formatter makes it a function of the server's environment.
 * The machine-readable form is in the `datetime` attribute beside it.
 */
export function formatInstant(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

const TYPE_LABELS: Record<string, string> = {
  planned: 'Planned change',
  correction: 'Correction',
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

function instantRow(term: string, iso: string): string {
  return (
    `        <dt>${escapeHtml(term)}</dt>\n` +
    `        <dd><time datetime="${escapeHtml(iso)}">${escapeHtml(
      formatInstant(iso)
    )}</time></dd>`
  );
}

function renderEntry(entry: ChangelogEntry): string {
  const lines: string[] = [];
  lines.push(`    <article id="${escapeHtml(entry.id)}">`);
  // The `#` is the conventional permalink affordance and gives a subscriber a
  // link to one entry they can keep. `aria-label` because "number sign link" is
  // what a screen reader would otherwise announce.
  lines.push(
    `      <h3>${escapeHtml(entry.title)} ` +
      `<a href="#${escapeHtml(entry.id)}" aria-label="Permalink to this entry">#</a></h3>`
  );

  if (entry.isExample) {
    // Loud, and above the entry rather than beside it. An example on a page a
    // subscriber may be pointed at has to be unmistakable at a glance, in the
    // same way the keys CLI frames the one-shot key banner.
    lines.push(
      '      <p><strong>EXAMPLE ENTRY. This describes no real change and gives notice of ' +
        'nothing.</strong></p>'
    );
  }

  lines.push('      <dl>');
  lines.push(`        <dt>Type</dt>`);
  lines.push(`        <dd>${escapeHtml(typeLabel(entry.type))}</dd>`);
  lines.push(instantRow('Published', entry.publishedAt));
  lines.push(instantRow('Effective', entry.effectiveAt));
  lines.push(`        <dt>Notice</dt>`);
  lines.push(`        <dd>${escapeHtml(describeNotice(entry))}</dd>`);
  lines.push('      </dl>');

  lines.push(`      <p>${escapeHtml(entry.detail)}</p>`);

  if (entry.whatWasWrong !== null) {
    lines.push(
      `      <p><strong>What was wrong:</strong> ${escapeHtml(entry.whatWasWrong)}</p>`
    );
  }

  lines.push('    </article>');
  return lines.join('\n');
}

export function renderChangelogHtml(entries: readonly ChangelogEntry[]): string {
  const ordered = sortEntriesNewestFirst(entries);

  const body =
    ordered.length === 0
      ? '    <p>No entries have been published yet.</p>'
      : ordered.map(renderEntry).join('\n\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Model and data change log</title>
</head>
<body>
  <h1>Model and data change log</h1>

  <p>Changes to the forecast models and the data behind this API are published here,
  newest first. All times are UTC.</p>

  <h2>How to read an entry</h2>

  <p>Every entry carries two times, and they are not the same time.</p>

  <dl>
    <dt>Published</dt>
    <dd>When the entry went up on this page.</dd>
    <dt>Effective</dt>
    <dd>When the change takes, or took, effect in the data we serve.</dd>
  </dl>

  <p>The interval between the two is the notice you were given, and every entry states
  it.</p>

  <h2>Types of entry</h2>

  <dl>
    <dt>Planned change</dt>
    <dd>A change to the models behind values we already serve. It is published here at
    least ${NOTICE_PERIOD_DAYS} days before it takes effect, so you have that long to see
    it coming.</dd>
    <dt>Correction</dt>
    <dd>A change that fixes values that were wrong. A correction is served as soon as it
    is ready and its entry is published at the same time, so it carries no advance
    notice. The entry says what was wrong.</dd>
  </dl>

  <h2>Entries</h2>

  <section>
${body}
  </section>
</body>
</html>
`;
}
