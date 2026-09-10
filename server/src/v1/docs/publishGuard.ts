/**
 * What must be true of the OpenAPI document before this site may render it.
 *
 * ## Why the site needs its own guard when `drift.test.ts` already has one
 *
 * They protect different things and would not catch each other's failures.
 * `openapi/drift.test.ts` asks *is the committed artifact what the code would
 * generate* — a question about a build. This asks *is the artifact safe to put
 * in front of a reader who holds none of our documents* — a question about a
 * publication. The artifact can be perfectly in step with the code and still be
 * unpublishable, which is exactly the state ABL-522 Constraint 2 describes and
 * the state `origin/main` was in until the citations were reworded.
 *
 * The direction matters too. The drift check runs in the server suite and its
 * failure means "regenerate". This runs in {@link renderDocsSite} itself, so the
 * failure mode is that **the site does not build**, on a laptop, before anything
 * is served. A guard that only ran in CI would be a guard the person previewing
 * the site never meets.
 *
 * ## The four blockers, and why each is a blocker and not a warning
 *
 * 1. **An `info` field this site does not render.** An allowlist, not a copy of
 *    `GATED_INFO_FIELDS` — deliberately. Mirroring that list would mean this
 *    guard is correct only as long as somebody remembers to update two files
 *    together, and `termsOfService`, `license` and `contact` are not the only
 *    three fields OpenAPI lets `info` carry. An allowlist refuses a field
 *    nobody has thought to gate yet, which is the class the constraint is
 *    actually about: not the decision to publish, but the default that
 *    publishes.
 *
 * 2. **A URL in a field OpenAPI defines as a link.** Note what this is *not*: a
 *    ban on the string `https://` anywhere in the document. `SeriesSource`
 *    carries `https://creativecommons.org/licenses/by/4.0/` as an example value
 *    of `licence_url`, and that URL is the one an integrator has a licence
 *    obligation to follow — refusing it would be the guard deleting the thing it
 *    exists to protect. An example value renders as inert `<code>` text; a
 *    `url` field renders as an anchor or is fetched. The position is the risk,
 *    not the character sequence.
 *
 * 3. **A clause citation, or a named reference to the subscriber terms.** The
 *    finding ABL-522 Constraint 2 names: a reader told an obligation comes from
 *    a numbered clause, with no way to open it. Correct inside the repo, a
 *    dangling reference the moment it is rendered.
 *
 * 4. **A `$ref` that leaves this document.** A remote `$ref` is a fetch, so it
 *    is Constraint 1 wearing a schema's clothes — and it would also make the
 *    rendered contract depend on a file no reviewer saw.
 *
 * Every one is a refusal rather than a warning for the reason the whole
 * constraint is written down: a warning on a build nobody watches is how the
 * default wins.
 */

/** The `info` fields this site renders. Everything else is refused — see above. */
export const RENDERABLE_INFO_FIELDS = ['title', 'summary', 'description', 'version'] as const;

/**
 * Keys OpenAPI gives URL semantics, at any depth.
 *
 * `url` covers `license.url`, `contact.url`, `externalDocs.url` and
 * `servers[].url` in one rule rather than four paths that each have to be
 * remembered. `servers[].url` is the one legitimate occupant, and only while it
 * stays relative — see {@link isRelativeUrl}.
 */
const URL_KEYS = new Set([
  'termsOfService',
  'url',
  'openIdConnectUrl',
  'authorizationUrl',
  'tokenUrl',
  'refreshUrl',
]);

/**
 * A citation of a numbered clause, in any of the shapes the repo writes them.
 *
 * `§` on its own is enough — it is a section sign and there is nothing else it
 * could be doing in an API description. The spelled-out forms need a digit
 * after them, because "this section" is ordinary prose and "section 7.1" is a
 * citation.
 */
const CLAUSE_CITATION = /§|\b(?:clause|section|article)\s+\d/i;

/**
 * Documents a reader cannot open while the gate is closed.
 *
 * Exact phrases, not the word "terms". `SeriesSource.licence_url` says the
 * licence deed is "deliberately not a link to our Terms" — prose that points a
 * reader *away* from a document rather than at one, which is not the failure
 * this catches and would be a false positive worth avoiding.
 */
const UNPUBLISHED_DOCUMENTS = [
  'terms of service',
  'terms of use',
  'terms and conditions',
  'subscriber terms',
  'acceptable use policy',
  'privacy notice',
  'privacy policy',
];

export interface PublicationBlocker {
  /** Where in the document, as a JSON pointer. */
  readonly pointer: string;
  /** What is wrong, in one line, written for whoever has to fix it. */
  readonly reason: string;
  /** The offending value, trimmed to something quotable in an error. */
  readonly excerpt: string;
}

export class UnpublishableDocumentError extends Error {
  constructor(readonly blockers: readonly PublicationBlocker[]) {
    super(
      `the OpenAPI document cannot be published as it stands (${blockers.length} blocker(s)):\n` +
        blockers.map((b) => `  ${b.pointer}: ${b.reason}\n    ${b.excerpt}`).join('\n')
    );
    this.name = 'UnpublishableDocumentError';
  }
}

/**
 * Relative, protocol-relative, or absolute?
 *
 * `//fonts.example.com/x.css` is absolute to a browser and looks relative to a
 * `startsWith('/')` check, which is why that check is not the one here.
 */
function isRelativeUrl(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}

function excerpt(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= 160 ? flat : `${flat.slice(0, 157)}…`;
}

function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Every blocker in the document, in document order.
 *
 * Returns them all rather than throwing on the first: the person fixing this is
 * editing `spec.ts`, regenerating and re-running, and a guard that reveals one
 * problem per cycle turns a ten-minute job into an afternoon.
 */
export function findPublicationBlockers(document: unknown): PublicationBlocker[] {
  const blockers: PublicationBlocker[] = [];

  const info = (document as { info?: Record<string, unknown> } | null)?.info;
  if (info && typeof info === 'object') {
    for (const field of Object.keys(info)) {
      if ((RENDERABLE_INFO_FIELDS as readonly string[]).includes(field)) continue;
      blockers.push({
        pointer: `/info/${escapePointerToken(field)}`,
        reason:
          `info.${field} is not one of the fields this site renders ` +
          `(${RENDERABLE_INFO_FIELDS.join(', ')}). Three of them — termsOfService, license, ` +
          `contact — are withheld by GATED_INFO_FIELDS while the ABL-349 gate is open; any ` +
          `other is a field whose publication nobody has decided on.`,
        excerpt: excerpt(typeof info[field] === 'string' ? String(info[field]) : JSON.stringify(info[field])),
      });
    }
  }

  walk(document, '', (pointer, key, value) => {
    if (typeof value === 'string') {
      if (key !== null && URL_KEYS.has(key) && !isRelativeUrl(value)) {
        blockers.push({
          pointer,
          reason:
            `${key} is a link this site would render or follow, and it is not relative to this ` +
            `origin. A published document may name no host we do not serve — that is ABL-522 ` +
            `Constraint 1, and it is also how a reader ends up at a draft that is not in force.`,
          excerpt: excerpt(value),
        });
      }

      if (key === '$ref' && !value.startsWith('#/')) {
        blockers.push({
          pointer,
          reason:
            'a $ref outside this document makes the rendered contract depend on a file that was ' +
            'never reviewed with it, and resolving it is a fetch.',
          excerpt: excerpt(value),
        });
      }

      if (CLAUSE_CITATION.test(value)) {
        blockers.push({
          pointer,
          reason:
            'cites a numbered clause. Published, this tells a reader an obligation binds them ' +
            'and gives them no way to read it — the subscriber terms are not in force while the ' +
            'ABL-349 gate is open. State the obligation in the document’s own words.',
          excerpt: excerpt(value),
        });
      }

      const lower = value.toLowerCase();
      const named = UNPUBLISHED_DOCUMENTS.find((name) => lower.includes(name));
      if (named !== undefined) {
        blockers.push({
          pointer,
          reason:
            `names the ${named}, which is not published. Same failure as a clause citation, ` +
            'reached through a document title instead of a number.',
          excerpt: excerpt(value),
        });
      }
    }
  });

  return blockers;
}

/** Throw unless the document may be published. Called by the renderer, not by a test. */
export function assertPublishable(document: unknown): void {
  const blockers = findPublicationBlockers(document);
  if (blockers.length > 0) throw new UnpublishableDocumentError(blockers);
}

/**
 * Depth-first over every string in the document, with its JSON pointer and the
 * key it sits under.
 *
 * `key` is `null` inside an array, which is what lets the `url` rule mean "a
 * field named url" rather than "any string that happens to be in a list beside
 * one".
 */
function walk(
  node: unknown,
  pointer: string,
  visit: (pointer: string, key: string | null, value: unknown) => void,
  key: string | null = null
): void {
  visit(pointer, key, node);

  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, `${pointer}/${index}`, visit, null));
    return;
  }

  if (node !== null && typeof node === 'object') {
    for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, `${pointer}/${escapePointerToken(childKey)}`, visit, childKey);
    }
  }
}
