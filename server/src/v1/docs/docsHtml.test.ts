import { describe, it, expect } from 'vitest';
import {
  renderIndexPage,
  renderReferencePage,
  renderTypeHtml,
  schemaAnchor,
  slug,
  untaggedOperations,
} from './docsHtml.js';
import type { OpenApiDocument } from './openApiDocument.js';

/**
 * Rendering behaviour, against a miniature document.
 *
 * The properties that matter to ABL-522 — nothing loads, nothing cites, every
 * link resolves — are asserted in `docsSite.test.ts` against the **real**
 * artifact, because a fixture can be made to satisfy them by being small. This
 * file is the other half: the cases a fixture states clearly and the artifact
 * happens to contain only one example of.
 */

const document = {
  openapi: '3.1.0',
  info: { title: 'Able Energy /v1', version: '1.0.0', summary: 'Electricity data.' },
  servers: [{ url: '/', description: 'Relative to the host you reach this API on.' }],
  tags: [
    { name: 'Discovery', description: 'The one resource that needs no key.' },
    { name: 'Observations', description: 'ENTSO-E-derived history.' },
  ],
  security: [{ apiKey: [] }],
  paths: {
    '/v1': {
      get: {
        operationId: 'getRoot',
        summary: 'Discovery root',
        tags: ['Discovery'],
        // The document-level requirement, overridden to "none" — OpenAPI's
        // spelling of "no key needed", and the case a reader cannot decode.
        security: [],
        responses: { '200': { description: 'The version.' } },
      },
    },
    '/v1/observations/load': {
      get: {
        operationId: 'getObservationsLoad',
        summary: 'Actual consumption',
        tags: ['Observations'],
        parameters: [
          {
            name: 'zone',
            in: 'query',
            required: true,
            description: 'Bidding-zone code.',
            schema: { type: 'string', pattern: '^[A-Za-z]{2}$' },
          },
        ],
        responses: {
          '200': {
            description: 'A page.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/LoadPage' } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      LoadPage: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/LoadRow' } },
          meta: {
            type: 'object',
            properties: {
              resource: { type: 'string', const: 'observations.load' },
              coverage: { type: 'string', enum: ['ok', 'no_data'] },
              note: { type: ['string', 'null'], description: 'Optional note.' },
            },
            required: ['resource', 'coverage'],
          },
          debug: {
            type: 'object',
            properties: { trace: { type: 'string' } },
            required: ['trace'],
          },
        },
        required: ['data', 'meta'],
        additionalProperties: false,
      },
      LoadRow: { type: 'object', properties: { load: { type: 'number' } }, required: ['load'] },
    },
    securitySchemes: {
      apiKey: { type: 'http', scheme: 'bearer', description: 'An API key.' },
    },
  },
} as unknown as OpenApiDocument;

describe('type phrases', () => {
  it('links a named schema to its own section instead of inlining it', () => {
    expect(renderTypeHtml({ $ref: '#/components/schemas/LoadRow' })).toBe(
      `<a href="#${schemaAnchor('LoadRow')}"><code>LoadRow</code></a>`
    );
  });

  it('describes an array by what it holds', () => {
    expect(
      renderTypeHtml({ type: 'array', items: { $ref: '#/components/schemas/LoadRow' } })
    ).toContain('array of <a href="#schema-loadrow">');
  });

  it('spells nullability out rather than dropping it', () => {
    // OpenAPI 3.1 writes it as a type array. A reader who is not told a field
    // can be null writes code that assumes it cannot.
    expect(renderTypeHtml({ type: ['string', 'null'] })).toBe(
      '<code>string</code> or <code>null</code>'
    );
  });

  it('lists every enum value', () => {
    // spec.ts has compile-time exhaustiveness assertions so the document cannot
    // omit a value the server can send. That is only worth anything if the page
    // carries the values across to the reader whose switch statement it is.
    const html = renderTypeHtml({ type: 'string', enum: ['ok', 'no_data'] });
    expect(html).toContain('<code>&quot;ok&quot;</code>');
    expect(html).toContain('<code>&quot;no_data&quot;</code>');
  });

  it('sets a pattern and a default as literals, not as prose', () => {
    expect(renderTypeHtml({ type: 'string', pattern: '^[A-Za-z]{2}$' })).toContain(
      'matching <code>^[A-Za-z]{2}$</code>'
    );
    expect(renderTypeHtml({ type: 'integer', minimum: 1, maximum: 10, default: 10 })).toContain(
      '1 to 10, default <code>10</code>'
    );
  });
});

describe('the reference page', () => {
  const html = renderReferencePage(document);

  it('flattens an inline object into dotted paths and links a named one', () => {
    // meta is declared inline with its fields under it; LoadRow is a $ref. A
    // nested table inside a table cell is unreadable with no stylesheet, and
    // `meta.coverage` is how the field is referred to in code anyway.
    expect(html).toContain('<code>meta.coverage</code>');
    expect(html).toContain('<code>data</code>');
    expect(html).not.toContain('<code>data.load</code>');
  });

  it('marks a nested field required only when its parent is required too', () => {
    // `debug.trace` is required *within* debug, and debug is optional. Marking
    // it required would tell a reader they can count on a field that may not be
    // there at all.
    const debugRow = html.slice(html.indexOf('<code>debug.trace</code>'));
    expect(debugRow.slice(0, 200)).toContain('<td>no</td>');

    const coverageRow = html.slice(html.indexOf('<code>meta.coverage</code>'));
    expect(coverageRow.slice(0, 300)).toContain('<td>yes</td>');
  });

  it('says in words which operations need a key', () => {
    // An empty `security` array is OpenAPI's spelling of "no key needed", and a
    // renderer is the only thing between that convention and a reader.
    const root = html.slice(html.indexOf('id="op-getroot"'));
    expect(root.slice(0, 300)).toContain('No API key required.');

    const load = html.slice(html.indexOf('id="op-getobservationsload"'));
    expect(load.slice(0, 300)).toContain('Requires an API key');
  });

  it('states that a closed schema is closed', () => {
    expect(html).toContain('No other fields are sent.');
  });
});

describe('the index page', () => {
  const html = renderIndexPage(document);

  it('takes its prose from info rather than from a second copy written here', () => {
    expect(html).toContain('Electricity data.');
  });

  it('counts the endpoints rather than stating a number that can go stale', () => {
    expect(html).toContain('Every one of the 2 endpoints');
  });
});

describe('coverage', () => {
  it('finds no operation the reference would silently omit', () => {
    // The reference renders operations by walking declared tags. An operation
    // with no tag, or with a tag the document does not declare, would simply
    // not appear — the silent-omission failure this module refuses everywhere
    // else. `docsSite.test.ts` runs the same check against the real artifact.
    expect(untaggedOperations(document)).toEqual([]);
  });

  it('detects one when there is one', () => {
    // The negative control on the check above: without this, an
    // `untaggedOperations` that always returned [] would pass.
    const stray = JSON.parse(JSON.stringify(document));
    stray.paths['/v1/stray'] = { get: { operationId: 'getStray', responses: {} } };
    expect(untaggedOperations(stray).map((o) => o.route)).toEqual(['/v1/stray']);
  });
});

describe('slugs', () => {
  it('is stable and lowercase', () => {
    expect(slug('Catalog')).toBe('catalog');
    expect(slug('meta.row_limit')).toBe('meta-row-limit');
  });
});
