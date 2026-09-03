import { describe, it, expect } from 'vitest';
import { readArtifact } from '../openapi/generate.js';
import {
  CHANGELOG_PATH,
  INDEX_PATH,
  OPENAPI_PATH,
  REFERENCE_PATH,
  operationAnchor,
  operationsForTag,
  schemaAnchor,
  untaggedOperations,
} from './docsHtml.js';
import { DOCS_PAGES, LINKED_ELSEWHERE, buildDocsSite, parseDocument } from './docsSite.js';
import { HTTP_METHODS } from './openApiDocument.js';

/**
 * The site, built from the **committed artifact**, asserted against the bytes a
 * reader would receive.
 *
 * Everything here is a property of the real publication rather than of a
 * fixture, and that is the point: ABL-522's constraints are claims about what
 * this site puts in front of somebody who holds none of our documents. A
 * fixture can be made to satisfy them by containing nothing.
 */

const artifact = readArtifact();
if (artifact === null) {
  throw new Error(
    'docs/api/v1/openapi.json is missing — run `npm run openapi:generate -w server`. ' +
      'Failing here rather than skipping: a documentation-site suite that quietly passes with ' +
      'no document is the silence this module exists to prevent.'
  );
}

const site = buildDocsSite(artifact);
const document = parseDocument(artifact);
const htmlPages = [...site].filter(([, resource]) => resource.contentType.startsWith('text/html'));

describe('the committed contract can be published as it stands', () => {
  it('builds', () => {
    // The load-bearing assertion in this file. `buildDocsSite` runs the
    // publication guard and the schema-keyword check before rendering, so if
    // the artifact cites a clause nobody can read, names a document that is not
    // in force, carries a URL off this origin, or states a constraint the
    // reference would silently drop, the site does not build and this fails
    // with the pointer to fix.
    expect(site.size).toBe(DOCS_PAGES.length);
  });

  it('serves exactly the pages the inventory names', () => {
    expect([...site.keys()].sort()).toEqual(DOCS_PAGES.map((page) => page.path).sort());
  });
});

describe('the machine-readable contract', () => {
  it('is the committed artifact byte for byte, not a re-serialisation of it', () => {
    // The artifact is what a reviewer approved in a diff. A round trip through
    // JSON.parse/JSON.stringify would publish a document that agrees with it
    // semantically and differs from it as a file — reopening exactly the gap
    // drift.test.ts closes, one layer downstream.
    expect(site.get(OPENAPI_PATH)?.body).toBe(artifact);
  });

  it('is served as JSON', () => {
    expect(site.get(OPENAPI_PATH)?.contentType).toBe('application/json; charset=utf-8');
  });
});

describe('the site loads nothing — ABL-522 Constraint 1', () => {
  it.each(htmlPages)('%s has no subresource of any kind', (_path, resource) => {
    // The public app sends `default-src 'none'`, so a browser would refuse
    // these — but the header is the second lock, not the first. A stylesheet
    // appearing here is the moment somebody has to widen that header, and
    // widening it is how an analytics default, a font CDN or a search widget
    // arrives without anyone deciding to accept one.
    for (const tag of ['<script', '<link', '<img', '<iframe', '<object', '<embed', '<svg', '<style']) {
      expect(resource.body).not.toContain(tag);
    }
  });

  it.each(htmlPages)('%s has no inline style or event handler', (_path, resource) => {
    expect(resource.body).not.toMatch(/\sstyle\s*=/);
    expect(resource.body).not.toMatch(/\son[a-z]+\s*=/);
    expect(resource.body).not.toMatch(/@import/);
  });

  it.each(htmlPages)('%s names no host at all', (_path, resource) => {
    // Absolute and protocol-relative both. A URL on this page is either a
    // subresource we are forbidden to load or an outbound link to a document
    // that is not in force; there is no third kind.
    expect(resource.body).not.toMatch(/https?:\/\//);
    expect(resource.body).not.toMatch(/href="\/\//);
    expect(resource.body).not.toMatch(/\ssrc\s*=/);
  });
});

describe('the site cites nothing it cannot show — ABL-522 Constraint 2', () => {
  it.each(htmlPages)('%s carries no clause citation', (_path, resource) => {
    // The finding Constraint 2 names. Inside the repo, "§7.1" is a useful
    // pointer; rendered here it tells a reader an obligation binds them and
    // gives them no way to read it.
    expect(resource.body).not.toMatch(/§/);
    expect(resource.body).not.toMatch(/\b(?:clause|article)\s+\d/i);
  });

  it.each(htmlPages)('%s does not name or link the subscriber terms', (_path, resource) => {
    const lower = resource.body.toLowerCase();
    for (const name of ['terms of service', 'terms of use', 'terms and conditions']) {
      expect(lower).not.toContain(name);
    }
  });

  it('renders none of the gated info fields, because the document carries none', () => {
    // GATED_INFO_FIELDS withholds these while the ABL-349 gate is open, and the
    // site must not reintroduce them in its rendering. Asserted from both ends:
    // absent from the document, and absent from the page.
    for (const field of ['termsOfService', 'license', 'contact'] as const) {
      expect(document.info).not.toHaveProperty(field);
    }
    for (const [, resource] of htmlPages) {
      expect(resource.body).not.toContain('Terms of Service');
    }
  });
});

describe('every link on the site resolves — ABL-522 Constraint 4', () => {
  const knownPaths = new Set<string>([...DOCS_PAGES.map((page) => page.path), ...LINKED_ELSEWHERE]);

  it.each(htmlPages)('%s links only to a fragment or to a path that exists', (_path, resource) => {
    for (const match of resource.body.matchAll(/href="([^"]+)"/g)) {
      const href = match[1];
      if (href.startsWith('#')) continue;
      expect(knownPaths).toContain(href);
    }
  });

  it.each(htmlPages)('%s has an element for every fragment it links to', (_path, resource) => {
    // A dangling `#schema-loadrow` is the same defect as a dangling clause
    // citation with the stakes lowered: the page promises the reader something
    // is over there and there is nothing over there.
    const ids = new Set([...resource.body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const match of resource.body.matchAll(/href="#([^"]+)"/g)) {
      expect(ids).toContain(match[1]);
    }
  });

  it('links the change log and does not serve it', () => {
    // ABL-522 Constraint 4, and the reason it is a link rather than a copy:
    // ABL-532's entries are rows published in under half a second by a CLI so a
    // correction's notice can go up at the same instant the correction is
    // served. Rendering them through this site would put that notice behind a
    // rebuild — the one thing Constraint 4's addendum says must not happen.
    expect(site.has(CHANGELOG_PATH)).toBe(false);
    for (const [, resource] of htmlPages) {
      expect(resource.body).toContain(`href="${CHANGELOG_PATH}"`);
    }
  });
});

describe('the reference covers the contract', () => {
  const reference = site.get(REFERENCE_PATH)?.body ?? '';

  it('leaves no operation untagged, so none is silently omitted', () => {
    expect(untaggedOperations(document)).toEqual([]);
  });

  it('renders every operation in the document', () => {
    for (const [route, item] of Object.entries(document.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = item[method];
        if (!operation) continue;
        expect(reference, `${method.toUpperCase()} ${route}`).toContain(
          `id="${operationAnchor(operation)}"`
        );
      }
    }
  });

  it('renders every schema in the document', () => {
    for (const name of Object.keys(document.components.schemas)) {
      expect(reference, name).toContain(`id="${schemaAnchor(name)}"`);
    }
  });

  it('places every operation under exactly one declared tag', () => {
    // An operation carrying two tags would be rendered twice, producing a
    // duplicate `id` — invalid HTML, and a fragment link that lands on
    // whichever copy the browser picks.
    const seen = new Map<string, number>();
    for (const tag of document.tags ?? []) {
      for (const { operation } of operationsForTag(document, tag.name)) {
        seen.set(operation.operationId, (seen.get(operation.operationId) ?? 0) + 1);
      }
    }
    expect([...seen].filter(([, count]) => count !== 1)).toEqual([]);
  });
});

describe('the index', () => {
  const index = site.get(INDEX_PATH)?.body ?? '';

  it('tells a reader how to authenticate before anything else asks them to', () => {
    expect(index).toContain('Authentication');
    expect(index).toContain('Authorization');
  });

  it('names the change log as the page to watch for model changes', () => {
    expect(index).toContain('Change log');
  });
});

describe('a malformed artifact', () => {
  it('is refused by name rather than crashing inside a renderer', () => {
    expect(() => buildDocsSite('{ not json')).toThrow(/openapi\.json is not valid JSON/);
    expect(() => buildDocsSite('{"openapi":"3.1.0"}')).toThrow(/missing one of/);
  });
});
