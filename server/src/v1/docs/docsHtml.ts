import { escapeHtml } from '../changelog/changelogHtml.js';
import { renderBlocks, renderInline } from './markdown.js';
import {
  HTTP_METHODS,
  constraintPhrases,
  flattenProperties,
  schemaRefName,
  typeNames,
  type OpenApiDocument,
  type OpenApiOperation,
  type OpenApiParameter,
  type OpenApiSchema,
} from './openApiDocument.js';

/**
 * The documentation site's HTML, as strings.
 *
 * ## It loads nothing, for the reason `changelogHtml.ts` loads nothing
 *
 * No stylesheet, no script, no font, no image, no favicon. ABL-532 established
 * this on `/changelog` and its module header names this issue while doing it:
 * the public app sends `Content-Security-Policy: default-src 'none'`, so adding
 * a subresource here would mean **widening that header**, and that header is the
 * only reason "no third-party analytics, no embedded font CDN, no third-party
 * search widget" is a property of the deployment rather than a promise about
 * what we remembered not to paste in.
 *
 * That is also the whole answer to ABL-522 Constraint 1's instruction to check
 * the starter template before adopting one. Docusaurus, Nextra, Mintlify and
 * VitePress each ship a client-side bundle and webfonts, and three of the four
 * ship or suggest a search widget. Adopting any of them does not merely risk an
 * analytics default arriving — it requires widening `default-src 'none'` on the
 * first day, after which the constraint is back to being something we remember.
 * The template question and the analytics question turn out to be one question.
 *
 * What is given up is real and worth stating: no navigation sidebar, no
 * try-it-out console, no client-side search. What replaces them is a page an
 * unstyled browser, a text browser and a screen reader all render correctly, and
 * one the reader's own find-in-page searches completely — because everything is
 * in the document rather than behind an expander.
 *
 * ## It cites nothing it cannot show
 *
 * No link to the subscriber terms, no clause number, and no absolute URL in any
 * attribute. `publishGuard.ts` refuses to build a site from a document that
 * carries one; `docsHtml.test.ts` asserts the property again against the
 * rendered bytes, because the guard checks the input and the reader sees the
 * output.
 */

/** Where the change log lives. It is ABL-532's page, on this origin, and this site links it. */
export const CHANGELOG_PATH = '/changelog';

/** Where this site serves the machine-readable contract. */
export const OPENAPI_PATH = '/openapi.json';

/** The reference page. One page, deliberately — see {@link renderReferencePage}. */
export const REFERENCE_PATH = '/reference';

/** The index. */
export const INDEX_PATH = '/';

interface NavItem {
  readonly href: string;
  readonly label: string;
}

const NAV: readonly NavItem[] = [
  { href: INDEX_PATH, label: 'Overview' },
  { href: REFERENCE_PATH, label: 'API reference' },
  { href: CHANGELOG_PATH, label: 'Change log' },
  { href: OPENAPI_PATH, label: 'OpenAPI document' },
];

/**
 * A slug safe to use as a fragment identifier.
 *
 * Applied to tag names and dotted field paths, both of which are ASCII in the
 * published document; the character class is a whitelist so a name that is not
 * cannot produce an id that has to be escaped differently in an `id` attribute
 * and in an `href`.
 */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function operationAnchor(operation: OpenApiOperation): string {
  return `op-${slug(operation.operationId)}`;
}

export function schemaAnchor(name: string): string {
  return `schema-${slug(name)}`;
}

function tagAnchor(name: string): string {
  return `tag-${slug(name)}`;
}

/**
 * The page shell.
 *
 * `<nav>` before `<main>` and both landmarked, because with no stylesheet the
 * only navigation a reader has is the document's own structure. A skip link is
 * the one concession: four nav items ahead of the content is four items a screen
 * reader reads on every page.
 */
export function renderShell({
  title,
  currentPath,
  body,
}: {
  title: string;
  currentPath: string;
  body: string;
}): string {
  const links = NAV.map((item) =>
    item.href === currentPath
      ? `      <li><strong>${escapeHtml(item.label)}</strong></li>`
      : `      <li><a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a></li>`
  ).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
  <a href="#main">Skip to content</a>
  <nav aria-label="Documentation">
    <ul>
${links}
    </ul>
  </nav>
  <main id="main">
${body}
  </main>
</body>
</html>
`;
}

/**
 * The overview page.
 *
 * Its prose comes from `info` rather than being written here. That is not
 * laziness: `info.description` is generated from `spec.ts` and drift-checked
 * against the running API, so the four rules an integrator most needs to believe
 * — sources named, absence never a silent zero, windows half-open and UTC, every
 * response paged and capped — are stated on this page by the same mechanism that
 * keeps them true. A second copy written by hand would be a copy that can be
 * wrong while every test passes.
 */
export function renderIndexPage(document: OpenApiDocument): string {
  const { info } = document;
  const scheme = Object.values(document.components.securitySchemes ?? {})[0];
  const operationCount = countOperations(document);

  const lines: string[] = [];
  lines.push(`    <h1>${escapeHtml(info.title)}</h1>`);
  if (info.summary) lines.push(`    <p>${renderInline(info.summary)}</p>`);
  if (info.description) lines.push(renderBlocks(info.description, { headingLevel: 2, indent: '    ' }));

  lines.push('');
  lines.push('    <h2>Authentication</h2>');
  if (scheme?.description) {
    lines.push(renderBlocks(scheme.description, { headingLevel: 3, indent: '    ' }));
  }

  lines.push('');
  lines.push('    <h2>Where things are</h2>');
  lines.push('    <dl>');
  lines.push(`      <dt><a href="${escapeHtml(REFERENCE_PATH)}">API reference</a></dt>`);
  lines.push(
    `      <dd>Every one of the ${operationCount} endpoints, with its parameters, its responses ` +
      `and the shape of every field they return.</dd>`
  );
  lines.push(`      <dt><a href="${escapeHtml(CHANGELOG_PATH)}">Change log</a></dt>`);
  lines.push(
    '      <dd>Changes to the forecast models and the data behind this API, newest first. Each ' +
      'entry carries the time it was published and the time it takes effect, which are not the ' +
      'same time. If you integrate against our forecasts, this is the page to watch.</dd>'
  );
  lines.push(`      <dt><a href="${escapeHtml(OPENAPI_PATH)}">OpenAPI document</a></dt>`);
  lines.push(
    `      <dd>The same contract as a machine-readable OpenAPI ${escapeHtml(document.openapi)} ` +
      'document, for generating a client. It is generated from the code that serves this API and ' +
      'checked against a running instance, so it describes what is served rather than what was ' +
      'intended.</dd>'
  );
  lines.push('    </dl>');

  lines.push('');
  lines.push('    <h2>Version</h2>');
  lines.push(
    `    <p>This document describes version <code>${escapeHtml(info.version)}</code> of the API.</p>`
  );

  return renderShell({ title: info.title, currentPath: INDEX_PATH, body: lines.join('\n') });
}

/**
 * The reference, as **one page**.
 *
 * With no client-side search and no sidebar, one page is what makes the
 * reference searchable at all: the reader's own find-in-page covers all ten
 * operations and all twenty-six schemas at once, and a link to any part of it is
 * a fragment that survives being pasted into a support thread. Split across
 * eleven pages it would need an index nobody maintains and a search box we are
 * not allowed to embed.
 */
export function renderReferencePage(document: OpenApiDocument): string {
  const lines: string[] = [];
  lines.push('    <h1>API reference</h1>');

  const server = document.servers?.[0];
  if (server?.description) {
    lines.push(`    <p>${renderInline(server.description)}</p>`);
  }

  lines.push('');
  lines.push('    <h2>Contents</h2>');
  lines.push('    <ul>');
  for (const tag of document.tags ?? []) {
    lines.push(`      <li><a href="#${tagAnchor(tag.name)}">${escapeHtml(tag.name)}</a>`);
    lines.push('        <ul>');
    for (const { route, method, operation } of operationsForTag(document, tag.name)) {
      lines.push(
        `          <li><a href="#${operationAnchor(operation)}">` +
          `<code>${escapeHtml(method.toUpperCase())} ${escapeHtml(route)}</code></a></li>`
      );
    }
    lines.push('        </ul>');
    lines.push('      </li>');
  }
  lines.push('      <li><a href="#schemas">Schemas</a></li>');
  lines.push('    </ul>');

  for (const tag of document.tags ?? []) {
    lines.push('');
    lines.push(`    <h2 id="${tagAnchor(tag.name)}">${escapeHtml(tag.name)}</h2>`);
    if (tag.description) lines.push(`    <p>${renderInline(tag.description)}</p>`);
    for (const { route, method, operation } of operationsForTag(document, tag.name)) {
      lines.push('');
      lines.push(renderOperation({ route, method, operation, document }));
    }
  }

  lines.push('');
  lines.push('    <h2 id="schemas">Schemas</h2>');
  lines.push(
    '    <p>The shapes referenced above. A field marked required is one every response of that ' +
      'kind carries; an optional object’s required field is listed as optional here, because a ' +
      'field you can only read when its parent is present is not one you can count on.</p>'
  );
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    lines.push('');
    lines.push(renderSchemaSection(name, schema));
  }

  return renderShell({
    title: `API reference — ${document.info.title}`,
    currentPath: REFERENCE_PATH,
    body: lines.join('\n'),
  });
}

function countOperations(document: OpenApiDocument): number {
  let count = 0;
  for (const item of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) if (item[method]) count += 1;
  }
  return count;
}

interface LocatedOperation {
  readonly route: string;
  readonly method: string;
  readonly operation: OpenApiOperation;
}

/** Operations carrying a tag, in document order. */
export function operationsForTag(document: OpenApiDocument, tag: string): LocatedOperation[] {
  const out: LocatedOperation[] = [];
  for (const [route, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation && (operation.tags ?? []).includes(tag)) out.push({ route, method, operation });
    }
  }
  return out;
}

/**
 * Operations carrying no tag, or a tag the document does not declare.
 *
 * Rendered by nobody — this exists so {@link renderReferencePage}'s coverage can
 * be asserted. An operation that falls through the tag loop would simply be
 * absent from the reference, which is the silent-omission failure this module
 * refuses everywhere else; `docsSite.test.ts` asserts this list is empty.
 */
export function untaggedOperations(document: OpenApiDocument): LocatedOperation[] {
  const declared = new Set((document.tags ?? []).map((tag) => tag.name));
  const out: LocatedOperation[] = [];
  for (const [route, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      if (!(operation.tags ?? []).some((tag) => declared.has(tag))) {
        out.push({ route, method, operation });
      }
    }
  }
  return out;
}

function renderOperation({
  route,
  method,
  operation,
  document,
}: LocatedOperation & { document: OpenApiDocument }): string {
  const lines: string[] = [];
  const heading = operation.summary
    ? `<code>${escapeHtml(method.toUpperCase())} ${escapeHtml(route)}</code> — ${escapeHtml(
        operation.summary
      )}`
    : `<code>${escapeHtml(method.toUpperCase())} ${escapeHtml(route)}</code>`;

  lines.push(`    <section>`);
  lines.push(`      <h3 id="${operationAnchor(operation)}">${heading}</h3>`);
  lines.push(`      <p>${renderAuthenticationNote(operation, document)}</p>`);

  if (operation.description) {
    lines.push(renderBlocks(operation.description, { headingLevel: 4, indent: '      ' }));
  }

  const parameters = operation.parameters ?? [];
  if (parameters.length > 0) {
    lines.push('      <h4>Parameters</h4>');
    lines.push('      <table>');
    lines.push(
      '        <thead><tr><th>Name</th><th>In</th><th>Required</th><th>Type</th>' +
        '<th>Description</th></tr></thead>'
    );
    lines.push('        <tbody>');
    for (const parameter of parameters) lines.push(renderParameterRow(parameter));
    lines.push('        </tbody>');
    lines.push('      </table>');
  }

  lines.push('      <h4>Responses</h4>');
  lines.push('      <dl>');
  for (const [status, response] of Object.entries(operation.responses)) {
    lines.push(`        <dt><code>${escapeHtml(status)}</code></dt>`);
    const schema = response.content?.['application/json']?.schema;
    const body = schema ? ` Body: ${renderTypeHtml(schema)}.` : '';
    lines.push(
      `        <dd>${response.description ? renderInline(response.description) : ''}${body}</dd>`
    );
  }
  lines.push('      </dl>');
  lines.push('    </section>');

  return lines.join('\n');
}

/**
 * Whether this operation needs a key, said in a sentence rather than a padlock.
 *
 * OpenAPI spells "no key needed" as an empty `security` array on the operation,
 * overriding the document-level requirement — a convention a renderer knows and
 * a reader does not. The discovery root is the only endpoint that carries it,
 * and getting it wrong in either direction wastes somebody's afternoon.
 */
function renderAuthenticationNote(
  operation: OpenApiOperation,
  document: OpenApiDocument
): string {
  const requirements = operation.security ?? document.security ?? [];
  return requirements.length === 0
    ? 'No API key required.'
    : 'Requires an API key in the <code>Authorization</code> header.';
}

function renderParameterRow(parameter: OpenApiParameter): string {
  const cells = [
    `<code>${escapeHtml(parameter.name)}</code>`,
    escapeHtml(parameter.in),
    parameter.required === true ? 'yes' : 'no',
    renderTypeHtml(parameter.schema),
    parameter.description ? renderInline(parameter.description) : '',
  ];
  return `          <tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
}

function renderSchemaSection(name: string, schema: OpenApiSchema): string {
  const lines: string[] = [];
  lines.push('    <section>');
  lines.push(
    `      <h3 id="${schemaAnchor(name)}">${escapeHtml(name)} ` +
      `<a href="#${schemaAnchor(name)}" aria-label="Permalink to this schema">#</a></h3>`
  );
  if (schema.description) {
    lines.push(renderBlocks(schema.description, { headingLevel: 4, indent: '      ' }));
  }

  const properties = flattenProperties(schema);
  if (properties.length === 0) {
    lines.push(`      <p>Type: ${renderTypeHtml(schema)}.</p>`);
    lines.push('    </section>');
    return lines.join('\n');
  }

  lines.push('      <table>');
  lines.push(
    '        <thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>'
  );
  lines.push('        <tbody>');
  for (const property of properties) {
    const cells = [
      `<code>${escapeHtml(property.path)}</code>`,
      renderTypeHtml(property.schema),
      property.required ? 'yes' : 'no',
      property.schema.description ? renderInline(property.schema.description) : '',
    ];
    lines.push(`          <tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`);
  }
  lines.push('        </tbody>');
  lines.push('      </table>');

  if (schema.additionalProperties === false) {
    lines.push(
      '      <p>No other fields are sent. A field arriving that is not listed here is a bug on ' +
        'our side, not an undocumented feature.</p>'
    );
  }

  lines.push('    </section>');
  return lines.join('\n');
}

/**
 * A schema as a type phrase, with named schemas linked to their own section.
 *
 * Enumerations are spelled out in full rather than summarised as "string". A
 * client's `switch` on a value we can send and did not list is the defect
 * `spec.ts`'s `Exhaustive<…>` assertions exist to prevent in the document; the
 * page has to carry the values across for that to reach a reader.
 */
export function renderTypeHtml(schema: OpenApiSchema): string {
  if (schema.$ref !== undefined) {
    const name = schemaRefName(schema.$ref);
    return name === null
      ? `<code>${escapeHtml(schema.$ref)}</code>`
      : `<a href="#${schemaAnchor(name)}"><code>${escapeHtml(name)}</code></a>`;
  }

  const names = typeNames(schema);
  const parts: string[] = [];

  if (names.includes('array')) {
    const item = schema.items ? renderTypeHtml(schema.items) : '<code>any</code>';
    parts.push(`array of ${item}`);
    for (const name of names) {
      if (name !== 'array') parts.push(`<code>${escapeHtml(name)}</code>`);
    }
  } else if (names.length > 0) {
    parts.push(names.map((name) => `<code>${escapeHtml(name)}</code>`).join(' or '));
  }

  if (schema.enum !== undefined) {
    const values = schema.enum
      .map((value) => `<code>${escapeHtml(JSON.stringify(value))}</code>`)
      .join(', ');
    parts.push(`one of ${values}`);
  }

  const constraints = constraintPhrases(schema).map(({ text, code }) =>
    code === null ? escapeHtml(text) : `${escapeHtml(text)} <code>${escapeHtml(code)}</code>`
  );
  if (constraints.length > 0) parts.push(constraints.join(', '));

  return parts.length === 0 ? '<code>any</code>' : parts.join('; ');
}
