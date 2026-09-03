import { readArtifact, ARTIFACT_PATH } from '../openapi/generate.js';
import { assertPublishable } from './publishGuard.js';
import { assertKnownSchemaKeywords, type OpenApiDocument } from './openApiDocument.js';
import {
  CHANGELOG_PATH,
  INDEX_PATH,
  OPENAPI_PATH,
  REFERENCE_PATH,
  renderIndexPage,
  renderReferencePage,
} from './docsHtml.js';

/**
 * The developer documentation site: a map from path to bytes, and nothing more.
 *
 * ## Why the site is a value rather than a server
 *
 * Building it produces a `Map`, and something else decides what to do with one.
 * `docsPreview.ts` serves it on loopback; a test asserts against it directly
 * without opening a port; and the day the ABL-349 gate lifts, mounting it is a
 * few lines in whichever composition is chosen — not a rewrite, because none of
 * the rendering knows what a request is.
 *
 * ## Why `publicApp.ts` does not import this
 *
 * ABL-522 Constraint 3: this site may not go live while the ABL-349 gate is
 * open, and the Board scheduled it as **build-and-hold** on 2026-09-03. The lock
 * on that is composition, the same mechanism ABL-304 uses for the internal
 * routes: the public app does not import this module, so there is no middleware
 * order and no configuration flag under which it serves a docs page. It is not
 * a route on that app in any environment.
 *
 * A flag would have been the obvious alternative and it is the weaker one. A
 * flag defaulting to off is a flag somebody turns on, and — worse — the site
 * would then be one deploy of an unrelated change away from being public, which
 * is precisely the "arrives by default rather than by decision" failure
 * Constraint 1 is written to prevent, pointed at Constraint 3. Composition makes
 * publishing a diff in a file somebody reviews.
 *
 * `docsNotPublished.test.ts` pins it from the other side, by name, so the
 * failure message says which constraint broke rather than that a module count
 * changed.
 */

export interface DocsResource {
  readonly contentType: string;
  readonly body: string;
}

export interface DocsPage {
  readonly path: string;
  readonly title: string;
  /** One line for a human reading the inventory, not rendered on the site. */
  readonly purpose: string;
}

/**
 * The page inventory, as required by ABL-522 Constraint 4 to be decided rather
 * than discovered.
 *
 * Three pages this site serves, and one it does not. `/changelog` is **not in
 * this list**, and that is the whole of Constraint 4's answer: the change log
 * already exists at a stable public URL outside `/v1` (ABL-532), it may be named
 * in the subscriber terms, and its entries are rows published in under half a
 * second by a CLI so that a correction's notice can go up at the same instant
 * the correction is served. Rendering it here would fork it; redirecting to it
 * would add a path to maintain for no reader. This site lands on the same
 * origin, so the correct absorption is a link — and the sub-second publish path
 * stays exactly as it is, which is the half of Constraint 4 that is about
 * latency rather than hosting.
 */
export const DOCS_PAGES: readonly DocsPage[] = [
  {
    path: INDEX_PATH,
    title: 'Overview',
    purpose: 'What the API is, how to authenticate, and where everything else is.',
  },
  {
    path: REFERENCE_PATH,
    title: 'API reference',
    purpose: 'Every endpoint and every schema, rendered from the published OpenAPI document.',
  },
  {
    path: OPENAPI_PATH,
    title: 'OpenAPI document',
    purpose: 'The committed artifact, served byte for byte for client generation.',
  },
];

/** The path this site links to but does not serve. See {@link DOCS_PAGES}. */
export const LINKED_ELSEWHERE: readonly string[] = [CHANGELOG_PATH];

export class MalformedArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedArtifactError';
  }
}

/**
 * Parse the artifact, refusing anything that is not the document we publish.
 *
 * Narrow rather than thorough: `drift.test.ts` already proves the artifact
 * matches the code that generates it, so this is not a validator. It exists so
 * that a truncated or hand-edited file fails here, naming the file, instead of
 * ten frames deep in a renderer reading `undefined.properties`.
 */
export function parseDocument(json: string): OpenApiDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new MalformedArtifactError(
      `${ARTIFACT_PATH} is not valid JSON: ${(cause as Error).message}`
    );
  }

  const document = parsed as Partial<OpenApiDocument>;
  if (
    typeof document?.openapi !== 'string' ||
    typeof document.info?.title !== 'string' ||
    typeof document.paths !== 'object' ||
    typeof document.components?.schemas !== 'object'
  ) {
    throw new MalformedArtifactError(
      `${ARTIFACT_PATH} is missing one of openapi, info.title, paths or components.schemas. ` +
        'Regenerate it with `npm run openapi:generate -w server`.'
    );
  }

  return document as OpenApiDocument;
}

/**
 * Render the whole site from one document.
 *
 * The two refusals run **before** anything is rendered, and both are refusals
 * rather than warnings:
 *
 * - {@link assertPublishable} — a document that cites a clause nobody can read,
 *   names a document that is not in force, or carries a URL off this origin is
 *   not published by this site at all. ABL-522 Constraint 2, enforced at the
 *   moment of building rather than in a review somebody has to remember to do.
 * - {@link assertKnownSchemaKeywords} — a constraint the contract states and
 *   this renderer would silently drop.
 *
 * `openapiJson` is served **byte for byte** rather than re-serialised from the
 * parsed document. The artifact is the thing reviewers approved in a diff, and a
 * round-trip through `JSON.parse`/`JSON.stringify` would publish a document that
 * agrees with it semantically and differs from it as a file — which is exactly
 * the gap `drift.test.ts` exists to close, reopened one layer downstream.
 */
export function buildDocsSite(openapiJson: string): Map<string, DocsResource> {
  const document = parseDocument(openapiJson);

  assertPublishable(document);
  assertKnownSchemaKeywords(document);

  return new Map<string, DocsResource>([
    [INDEX_PATH, { contentType: 'text/html; charset=utf-8', body: renderIndexPage(document) }],
    [
      REFERENCE_PATH,
      { contentType: 'text/html; charset=utf-8', body: renderReferencePage(document) },
    ],
    [OPENAPI_PATH, { contentType: 'application/json; charset=utf-8', body: openapiJson }],
  ]);
}

/** Build the site from the committed artifact. Throws if it has not been generated. */
export function loadDocsSite(): Map<string, DocsResource> {
  const json = readArtifact();
  if (json === null) {
    throw new MalformedArtifactError(
      `${ARTIFACT_PATH} does not exist. Generate it with \`npm run openapi:generate -w server\`.`
    );
  }
  return buildDocsSite(json);
}
