import { describe, it, expect } from 'vitest';
import {
  UnpublishableDocumentError,
  assertPublishable,
  findPublicationBlockers,
} from './publishGuard.js';

/**
 * ABL-522 Constraint 2, as assertions.
 *
 * The document under test is a miniature rather than the real artifact: this
 * file is about what the guard *refuses*, and the real artifact is (and must
 * stay) a document with nothing to refuse. `docsSite.test.ts` runs the guard
 * against the committed artifact and is the positive control.
 */

const clean = {
  openapi: '3.1.0',
  info: {
    title: 'Able Energy /v1',
    version: '1.0.0',
    summary: 'European electricity observations.',
    description: 'A read-only JSON API.',
  },
  servers: [{ url: '/', description: 'Relative to the host you reach this API on.' }],
  paths: {},
  components: { schemas: {} },
};

/** Deep-clone so a mutation in one test cannot leak into the next. */
function withDocument(mutate: (doc: Record<string, any>) => void): Record<string, any> {
  const doc = JSON.parse(JSON.stringify(clean));
  mutate(doc);
  return doc;
}

describe('a document that may be published', () => {
  it('has no blockers', () => {
    expect(findPublicationBlockers(clean)).toEqual([]);
  });

  it('keeps a licence deed URL that appears as example data', () => {
    // The regression this guard is most likely to acquire. SeriesSource carries
    // https://creativecommons.org/licenses/by/4.0/ as an example value of
    // `licence_url`, and it is the one URL an integrator has a licence
    // obligation to follow. A "no https:// anywhere" rule would refuse to
    // publish the very thing attribution depends on — the risk is the position
    // a URL sits in, not the characters.
    const doc = withDocument((d) => {
      d.components.schemas.SeriesSource = {
        type: 'object',
        properties: { licence_url: { type: ['string', 'null'] } },
        examples: [{ licence_url: 'https://creativecommons.org/licenses/by/4.0/' }],
      };
    });

    expect(findPublicationBlockers(doc)).toEqual([]);
  });

  it('keeps prose that points a reader away from a document', () => {
    // SeriesSource.licence_url really says "Deliberately not a link to our
    // Terms". That is the opposite of a dangling citation and must not trip a
    // rule keyed on the bare word "terms".
    const doc = withDocument((d) => {
      d.components.schemas.SeriesSource = {
        type: 'object',
        description: 'Deliberately not a link to our Terms: a use licence is not a public deed.',
      };
    });

    expect(findPublicationBlockers(doc)).toEqual([]);
  });
});

describe('info fields', () => {
  it.each(['termsOfService', 'license', 'contact'])('refuses info.%s', (field) => {
    const doc = withDocument((d) => {
      d.info[field] = field === 'termsOfService' ? '/terms' : { name: 'x' };
    });

    const blockers = findPublicationBlockers(doc);
    expect(blockers.map((b) => b.pointer)).toContain(`/info/${field}`);
  });

  it('refuses an info field nobody has thought to gate', () => {
    // The reason this is an allowlist and not a copy of GATED_INFO_FIELDS. A
    // guard that names three fields is correct until OpenAPI or a template
    // offers a fourth, and the constraint is about the default that publishes
    // rather than the decision to publish.
    const doc = withDocument((d) => {
      d.info['x-legal-notice'] = 'See our subscriber agreement.';
    });

    expect(findPublicationBlockers(doc).map((b) => b.pointer)).toContain('/info/x-legal-notice');
  });

  it('says why, in a sentence someone can act on', () => {
    const doc = withDocument((d) => {
      d.info.termsOfService = '/terms';
    });

    expect(findPublicationBlockers(doc)[0].reason).toMatch(/GATED_INFO_FIELDS/);
  });
});

describe('links', () => {
  it('accepts a relative server URL', () => {
    expect(findPublicationBlockers(clean)).toEqual([]);
  });

  it('refuses an absolute server URL', () => {
    const doc = withDocument((d) => {
      d.servers[0].url = 'https://api.example.com';
    });

    expect(findPublicationBlockers(doc).map((b) => b.pointer)).toContain('/servers/0/url');
  });

  it('refuses a protocol-relative URL, which startsWith("/") would let through', () => {
    const doc = withDocument((d) => {
      d.servers[0].url = '//fonts.example.com/style.css';
    });

    expect(findPublicationBlockers(doc).map((b) => b.pointer)).toContain('/servers/0/url');
  });

  it('refuses an externalDocs URL wherever it appears', () => {
    const doc = withDocument((d) => {
      d.components.schemas.LoadRow = {
        type: 'object',
        externalDocs: { url: 'https://example.com/loadrow' },
      };
    });

    expect(findPublicationBlockers(doc).map((b) => b.pointer)).toContain(
      '/components/schemas/LoadRow/externalDocs/url'
    );
  });

  it('refuses a $ref that leaves the document', () => {
    const doc = withDocument((d) => {
      d.components.schemas.LoadRow = { $ref: 'https://example.com/schemas/LoadRow.json' };
    });

    const blockers = findPublicationBlockers(doc);
    expect(blockers.map((b) => b.pointer)).toContain('/components/schemas/LoadRow/$ref');
  });

  it('keeps a local $ref', () => {
    const doc = withDocument((d) => {
      d.components.schemas.Page = {
        type: 'object',
        properties: { row: { $ref: '#/components/schemas/LoadRow' } },
      };
    });

    expect(findPublicationBlockers(doc)).toEqual([]);
  });
});

describe('citations', () => {
  it.each([
    ['a section sign', 'Taken word for word from §7.1 of the agreement.'],
    ['a spelled-out clause', 'This obligation is imposed by clause 7.3.'],
    ['a spelled-out section', 'See Section 8.1 for the attribution requirement.'],
    ['an article', 'Article 2 of the agreement applies.'],
  ])('refuses %s', (_label, description) => {
    const doc = withDocument((d) => {
      d.components.schemas.SeriesSource = { type: 'object', description };
    });

    const blockers = findPublicationBlockers(doc);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].pointer).toBe('/components/schemas/SeriesSource/description');
    expect(blockers[0].reason).toMatch(/cites a numbered clause/);
  });

  it('does not refuse ordinary prose containing the word section', () => {
    const doc = withDocument((d) => {
      d.components.schemas.SeriesSource = {
        type: 'object',
        description: 'The schemas section below lists every shape.',
      };
    });

    expect(findPublicationBlockers(doc)).toEqual([]);
  });

  it.each([
    'terms of service',
    'Terms of Service',
    'terms and conditions',
    'acceptable use policy',
    'Privacy Notice',
  ])('refuses a named reference to the %s', (name) => {
    const doc = withDocument((d) => {
      d.components.schemas.SeriesSource = { type: 'object', description: `Governed by our ${name}.` };
    });

    expect(findPublicationBlockers(doc)).toHaveLength(1);
  });

  it('finds a citation wherever it is, not only in info', () => {
    const doc = withDocument((d) => {
      d.paths['/v1/observations/load'] = {
        get: {
          operationId: 'getObservationsLoad',
          responses: { '200': { description: 'A page. Attribution per §7.3.' } },
        },
      };
    });

    expect(findPublicationBlockers(doc).map((b) => b.pointer)).toContain(
      '/paths/~1v1~1observations~1load/get/responses/200/description'
    );
  });
});

describe('reporting', () => {
  it('returns every blocker rather than the first', () => {
    // The person fixing this edits spec.ts, regenerates and re-runs. One
    // problem per cycle turns a ten-minute job into an afternoon.
    const doc = withDocument((d) => {
      d.info.termsOfService = '/terms';
      d.info.contact = { name: 'Support' };
      d.components.schemas.A = { type: 'object', description: 'See §7.1.' };
    });

    expect(findPublicationBlockers(doc).length).toBeGreaterThanOrEqual(3);
  });

  it('throws with every pointer in the message', () => {
    const doc = withDocument((d) => {
      d.info.termsOfService = '/terms';
      d.components.schemas.A = { type: 'object', description: 'See §7.1.' };
    });

    try {
      assertPublishable(doc);
      expect.unreachable('assertPublishable should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnpublishableDocumentError);
      expect((error as Error).message).toContain('/info/termsOfService');
      expect((error as Error).message).toContain('/components/schemas/A/description');
    }
  });

  it('does not throw for a document that may be published', () => {
    expect(() => assertPublishable(clean)).not.toThrow();
  });
});
