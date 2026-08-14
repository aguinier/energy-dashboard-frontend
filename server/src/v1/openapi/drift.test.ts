import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createV1Routes } from '../routes/index.js';
import publicRootRoutes from '../routes/root.js';
import { requireApiKey } from '../auth/apiKeyAuth.js';
import { publicErrorHandler, publicNotFoundHandler } from '../publicErrors.js';
import { createMemoryApiKeyDirectory } from '../keys/memoryApiKeyDirectory.js';
import {
  createMemoryDataContext,
  createMemoryEnergySource,
  type MemoryEnergySource,
} from '../data/memoryEnergySource.js';
import { ABLE_FORECAST, ENTSOE_OBSERVATION } from '../data/attribution.js';
import { PRODUCTION_TYPES } from '../data/series.js';
import { buildOpenApiDocument, renderOpenApiDocument, GATED_INFO_FIELDS } from './spec.js';
import { ARTIFACT_PATH, readArtifact } from './generate.js';
import { listRoutes } from './routeInventory.js';
import { formatProblems, validateAgainstSchema, type JsonSchema } from './schemaCheck.js';

/**
 * **The drift check.** ABL-305's second half, and the reason the first half is
 * worth publishing.
 *
 * A specification is a promise about what a response contains. Nothing enforces
 * a promise written in a JSON file, so this suite reads the published document
 * and the running implementation and fails when they disagree. Four kinds of
 * disagreement are caught, and they fail for different reasons:
 *
 * | drift | caught by |
 * |---|---|
 * | the artifact is stale — code changed, `openapi.json` did not | a fresh build compared byte for byte |
 * | a route exists that the document does not describe | the Express route table vs. `paths` |
 * | a promised field stopped arriving | `required`, against real response bodies |
 * | a field arrives that nobody documented | `additionalProperties: false`, same bodies |
 *
 * A fifth is enforced by `tsc` rather than here: `spec.ts` carries
 * `Exhaustive<…>` assertions, so adding a value to `Coverage` or
 * `FreshnessStatus` without adding it to the published enum fails the **build**.
 *
 * ## Two negative controls, because a check that never fails is decoration
 *
 * The most likely way for this file to stop working is not a false failure but
 * a silent pass — a validator that returns `[]`, a route list that comes back
 * empty, a schema that constrains nothing. So two blocks below deliberately
 * break a real response and assert that validation *rejects* it, and
 * `schemaCheck.test.ts` does the same for the validator itself.
 *
 * ## What this does not cover, stated rather than implied
 *
 * - **Query parameters the implementation accepts but the document omits.**
 *   There is no way to enumerate what a handler reads off `req.query`. The
 *   reverse — a documented parameter the implementation ignores or refuses — is
 *   covered by the behavioural block below.
 * - **Semantics.** That `mape` is a mean absolute percentage error and not
 *   something else is not a shape, and no drift check will find it. That is what
 *   `v1Contract.test.ts` is for.
 * - **Status codes beyond those exercised here.** 403 and 429 share the one
 *   `Error` schema with the codes that are exercised, and the block below
 *   asserts they do, so a change to the error envelope cannot reach them
 *   unnoticed. Their own behaviour is `apiKeyAuth.test.ts`'s and
 *   `planGate.test.ts`'s.
 */

const NOW = new Date('2026-08-12T12:00:00Z');
const DOCUMENT = buildOpenApiDocument();

let source: MemoryEnergySource;
let api: { origin: string; close: () => Promise<void> };

/** `2026-08-12 11:00:00` — the space-separated form the ingest writes. */
function stored(iso: string): string {
  return iso.replace('T', ' ').replace('Z', '');
}

beforeAll(async () => {
  source = createMemoryEnergySource();
  seed(source);

  const app = express();
  app.use('/v1', publicRootRoutes);
  app.use('/v1', createV1Routes(createMemoryDataContext(source, { now: () => NOW })));
  app.use(publicNotFoundHandler);
  app.use(publicErrorHandler);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  api = {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
});

afterAll(async () => {
  await api.close();
  source.close();
});

/**
 * A fleet chosen so that every documented shape has a response that exercises
 * it — including the ones a happy path never reaches.
 *
 * DE holds all three streams and two forecast vintages, and its actuals pair
 * with its forecasts so `/v1/accuracy` returns measured numbers rather than the
 * all-`null` row. FR is `xgboost` where DE is `catboost`. GB stopped in 2021, so
 * `status: "ended"` is a real response and not a hypothetical. XX is in
 * `countries` and nothing else, which is the only way to see `status: "none"`
 * and a `null` span on a catalogue entry.
 */
function seed(db: MemoryEnergySource): void {
  db.zones('DE', 'FR', 'GB', 'XX');

  for (let hour = 0; hour < 60; hour += 1) {
    const iso = new Date(Date.UTC(2026, 7, 10, hour)).toISOString().slice(0, 19);
    if (hour === 30) continue; // one hole, so `resolution_uniform: false` is reachable
    db.load('DE', stored(`${iso}Z`), 40_000 + hour);
  }
  for (let hour = 0; hour < 48; hour += 1) {
    const iso = new Date(Date.UTC(2026, 7, 12, hour)).toISOString().slice(0, 19);
    db.price('DE', stored(`${iso}Z`), hour === 3 ? -12.5 : 90 + hour);
  }
  for (let hour = 0; hour < 24; hour += 1) {
    const iso = new Date(Date.UTC(2026, 7, 12, hour)).toISOString().slice(0, 19);
    // `nuclear_mw` deliberately absent from the insert: it must arrive as null,
    // which is the value the published schema has to admit.
    db.generation('DE', stored(`${iso}Z`), {
      solar_mw: hour < 6 ? 0 : 5_000,
      wind_onshore_mw: 12_000,
    });
  }
  for (let hour = 0; hour < 12; hour += 1) {
    const iso = new Date(Date.UTC(2026, 7, 12, hour)).toISOString().slice(0, 19);
    db.load('FR', stored(`${iso}Z`), 50_000 + hour);
  }
  db.load('GB', '2021-06-14T09:00:00', 30_000);

  // DE load forecasts over hours the seeded actuals also cover, so accuracy has
  // pairs and the measured (non-null) metric shape is the one validated.
  for (let hour = 0; hour < 24; hour += 1) {
    db.forecast({
      zone: 'DE',
      type: 'load',
      target: `2026-08-11T${String(hour).padStart(2, '0')}:00:00`,
      generatedAt: '2026-08-10T14:00:00.100000',
      horizonHours: hour + 10,
      value: 41_000,
      model: 'catboost',
    });
  }
  for (let hour = 12; hour < 20; hour += 1) {
    db.forecast({
      zone: 'DE',
      type: 'load',
      target: `2026-08-12T${String(hour).padStart(2, '0')}:00:00`,
      generatedAt: '2026-08-12T14:00:00.100000',
      horizonHours: hour,
      value: 200,
      model: 'catboost',
    });
  }
  for (let hour = 12; hour < 16; hour += 1) {
    db.forecast({
      zone: 'FR',
      type: 'load',
      target: `2026-08-12T${String(hour).padStart(2, '0')}:00:00`,
      generatedAt: '2026-08-12T14:00:00.100000',
      horizonHours: hour,
      value: 300,
      model: 'xgboost',
    });
  }

  db.ingestPass({
    pipelineType: 'load',
    zone: 'DE',
    startTime: '2026-08-12T06:30:00+00:00',
    endTime: '2026-08-12T06:41:00+00:00',
  });
  db.ingestPass({
    pipelineType: 'price',
    zone: 'DE',
    startTime: '2026-08-12T06:30:00+00:00',
    endTime: '2026-08-12T06:42:00+00:00',
  });
  db.ingestPass({
    pipelineType: 'renewable',
    zone: 'DE',
    startTime: '2026-08-12T06:30:00+00:00',
    endTime: '2026-08-12T06:43:00+00:00',
  });
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${api.origin}${path}`);
  return { status: res.status, body: await res.json() };
}

/** The `application/json` schema a documented operation promises for one status. */
function responseSchema(path: string, status: string): JsonSchema {
  const operation = (DOCUMENT.paths as Record<string, { get?: Record<string, unknown> }>)[path]?.get;
  if (operation === undefined) throw new Error(`no GET operation documented for ${path}`);
  const responses = operation.responses as Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
  const schema = responses[status]?.content?.['application/json']?.schema;
  if (schema === undefined) throw new Error(`no ${status} JSON schema documented for ${path}`);
  return schema;
}

function expectValid(schema: JsonSchema, body: unknown, what: string): void {
  const problems = validateAgainstSchema(DOCUMENT, schema, body);
  expect(problems, `${what} does not match the published schema:\n${formatProblems(problems)}`).toEqual(
    []
  );
}

/**
 * One request per documented shape, and every one of these is a *different*
 * schema branch — a filtered generation page, an empty page, an unmeasurable
 * accuracy window, a catalogue entry for a zone we hold nothing for.
 */
const DOCUMENTED_RESPONSES: ReadonlyArray<{ path: string; request: string; why: string }> = [
  { path: '/v1', request: '/v1', why: 'discovery root' },
  {
    path: '/v1/observations/load',
    request: '/v1/observations/load?zone=DE&from=2026-08-10&to=2026-08-13',
    why: 'a full load page',
  },
  {
    path: '/v1/observations/load',
    request: '/v1/observations/load?zone=DE&from=2026-08-10&to=2026-08-13&limit=5',
    why: 'a truncated page, which is the only one carrying a non-null links.next',
  },
  {
    path: '/v1/observations/load',
    request: '/v1/observations/load?zone=GB&from=2026-08-12&to=2026-08-13',
    why: 'an empty page from a zone that stopped publishing',
  },
  {
    path: '/v1/observations/price',
    request: '/v1/observations/price?zone=DE&from=2026-08-12&to=2026-08-13',
    why: 'prices, including a negative one',
  },
  {
    path: '/v1/observations/generation',
    request: '/v1/observations/generation?zone=DE&from=2026-08-12&to=2026-08-13',
    why: 'all 21 production types, with nulls for the ones DE does not report',
  },
  {
    path: '/v1/observations/generation',
    request:
      '/v1/observations/generation?zone=DE&from=2026-08-12&to=2026-08-13&production_type=solar,wind_onshore',
    why: 'a narrowed generation page — the case that stops the row schema requiring all 21',
  },
  {
    path: '/v1/forecasts',
    request: '/v1/forecasts?zone=DE&type=load&from=2026-08-12&to=2026-08-13',
    why: 'forecasts with a resolved model',
  },
  {
    path: '/v1/forecasts',
    request: '/v1/forecasts?zone=XX&type=price&from=2026-08-12&to=2026-08-13',
    why: 'a forecast page where no model has rows at all — meta.model is null here',
  },
  {
    path: '/v1/forecasts/latest',
    request: '/v1/forecasts/latest?zone=DE&type=load',
    why: 'one whole run',
  },
  {
    path: '/v1/accuracy',
    request: '/v1/accuracy?zone=DE&type=load&from=2026-08-11&to=2026-08-12',
    why: 'measured accuracy — metrics present as numbers',
  },
  {
    path: '/v1/accuracy',
    request: '/v1/accuracy?zone=XX&type=load&from=2026-08-11&to=2026-08-12',
    why: 'an unmeasurable window — every metric null, which is a different shape',
  },
  { path: '/v1/catalog/zones', request: '/v1/catalog/zones', why: 'the zone catalogue' },
  { path: '/v1/catalog/models', request: '/v1/catalog/models', why: 'the model catalogue' },
  {
    path: '/v1/catalog/coverage',
    request: '/v1/catalog/coverage?zone=DE&stream=load',
    why: 'coverage without a window — the window block must be absent, not null',
  },
  {
    path: '/v1/catalog/coverage',
    request:
      '/v1/catalog/coverage?zone=DE&stream=load&from=2026-08-11T00:00:00Z&to=2026-08-12T00:00:00Z',
    why: 'coverage with a window, enumerating a real gap',
  },
];

describe('the artifact is the document', () => {
  it('docs/api/v1/openapi.json is what spec.ts builds today', () => {
    const committed = readArtifact();
    expect(
      committed,
      `${ARTIFACT_PATH} is missing. Run: npm run openapi:generate -w server`
    ).not.toBeNull();

    // Byte for byte (line endings aside — see `normaliseEol`), not a deep-equal
    // on parsed JSON: the committed file is the thing a reviewer reads and a
    // docs pipeline consumes, so a reformat is a diff worth seeing.
    expect(
      committed,
      'The committed OpenAPI artifact is stale. Run: npm run openapi:generate -w server'
    ).toBe(renderOpenApiDocument());
  });

  it('is a 3.1 document with the pieces a client generator needs', () => {
    expect(DOCUMENT.openapi).toBe('3.1.0');
    expect(DOCUMENT.info.title).toBeTruthy();
    expect(DOCUMENT.info.version).toBeTruthy();
    expect(DOCUMENT.components.securitySchemes.apiKey).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });
});

describe('ABL-349 — the document must not publish a subscriber-facing document by reference', () => {
  // The gate item most easily lost by *default* rather than by neglect: a spec
  // scaffolded from a template fills these in as a matter of course.

  it.each(GATED_INFO_FIELDS)('info.%s is unset', (field) => {
    expect(
      Object.prototype.hasOwnProperty.call(DOCUMENT.info, field),
      `info.${field} publishes a subscriber-facing document by reference and the ABL-349 gate is open`
    ).toBe(false);
  });

  it('points at no URL of ours anywhere in the document', () => {
    // Broader than the three fields, because `externalDocs`, a server URL or a
    // description containing a link would do the same job by another route.
    const urls = new Set<string>();
    const collect = (node: unknown): void => {
      if (typeof node === 'string') {
        for (const match of node.matchAll(/https?:\/\/[^\s)'"`]+/g)) urls.add(match[0]);
        return;
      }
      if (Array.isArray(node)) return node.forEach(collect);
      if (node !== null && typeof node === 'object') Object.values(node).forEach(collect);
    };
    collect(DOCUMENT);

    // The CC-BY deed is upstream's licence, already on every observation
    // response, and is not one of our documents. It is the only URL allowed.
    expect([...urls].sort()).toEqual([ENTSOE_OBSERVATION.licence_url]);
  });

  it('publishes no absolute server address', () => {
    // A LAN address or a guessed hostname in a published document is a URL a
    // client hardcodes, and choosing one is a network-exposure decision that is
    // not this issue's to take.
    const servers = DOCUMENT.servers as Array<{ url: string }>;
    for (const server of servers) expect(server.url.startsWith('/')).toBe(true);
  });
});

describe('every route is documented, and every documented route exists', () => {
  it('the Express route table and the OpenAPI paths are the same set', () => {
    const mounted = [
      ...listRoutes(publicRootRoutes, '/v1'),
      ...listRoutes(createV1Routes(createMemoryDataContext(source, { now: () => NOW })), '/v1'),
    ];

    const mountedPairs = mounted
      .flatMap((route) => route.methods.map((method) => `${method.toUpperCase()} ${route.path}`))
      .sort();

    const documentedPairs = Object.entries(DOCUMENT.paths)
      .flatMap(([path, item]) =>
        Object.keys(item as Record<string, unknown>).map(
          (method) => `${method.toUpperCase()} ${path}`
        )
      )
      .sort();

    // A route added to `routes/index.ts` without a matching entry in `spec.ts`
    // fails here — which is the whole reason this inventory reads the router
    // tree rather than probing paths somebody remembered to list.
    expect(documentedPairs).toEqual(mountedPairs);
  });

  it('found the routes rather than an empty list', () => {
    // The negative control for the assertion above: two empty sets are equal,
    // and an inventory that silently returned nothing would pass it forever.
    const mounted = listRoutes(
      createV1Routes(createMemoryDataContext(source, { now: () => NOW })),
      '/v1'
    );
    expect(mounted.length).toBeGreaterThanOrEqual(9);
    expect(mounted.map((route) => route.path)).toContain('/v1/observations/generation');
  });
});

describe('real responses match the published schemas', () => {
  it.each(DOCUMENTED_RESPONSES)('$request — $why', async ({ path, request }) => {
    const { status, body } = await get(request);
    expect(status).toBe(200);
    expectValid(responseSchema(path, '200'), body, request);
  });

  it('every timestamp on the wire is RFC 3339 UTC at second precision', async () => {
    // The contract `format: date-time` would only gesture at. Asserted against
    // the value, with the grammar the document states in prose.
    const { body } = await get('/v1/observations/load?zone=DE&from=2026-08-10&to=2026-08-13');
    const stamps: string[] = [];
    const collect = (node: unknown, key: string): void => {
      if (typeof node === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(node)) stamps.push(`${key}=${node}`);
      else if (Array.isArray(node)) node.forEach((entry) => collect(entry, key));
      else if (node !== null && typeof node === 'object') {
        for (const [name, value] of Object.entries(node)) collect(value, name);
      }
    };
    collect(body, 'root');

    expect(stamps.length).toBeGreaterThan(0);
    for (const stamp of stamps) {
      expect(stamp).toMatch(/=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });

  it('an unfiltered generation response carries exactly the documented production types', async () => {
    // `GenerationRow.required` is `timestamp` alone, because `?production_type=`
    // narrows the set. That makes this the assertion that a production type
    // cannot silently vanish: the *unfiltered* response must carry all of them.
    const { body } = await get('/v1/observations/generation?zone=DE&from=2026-08-12&to=2026-08-13');
    const row = (body as { data: Array<Record<string, unknown>> }).data[0];
    const documented = Object.keys(
      DOCUMENT.components.schemas.GenerationRow.properties as Record<string, unknown>
    );

    expect(Object.keys(row).sort()).toEqual(documented.sort());
    expect(documented.sort()).toEqual(['timestamp', ...PRODUCTION_TYPES].sort());
  });
});

describe('ToS §7.3 — the source and attribution field is part of the published contract', () => {
  // ABL-297, filed on this issue from a Board decision. The promise is that a
  // subscriber can render CC-BY 4.0 attribution *programmatically*, and a field
  // that exists in responses but not in the published contract is a field
  // integrators will not know to read — which leaves them in breach of an
  // obligation we passed to them.

  const schemas = () => DOCUMENT.components.schemas;

  it('is required, with every one of its own fields required', () => {
    const source = schemas().SeriesSource;
    expect(source.required).toEqual([
      'id',
      'name',
      'licence',
      'licence_url',
      'attribution_required',
      'attribution',
    ]);
    // No undeclared field either: an attribution block that grew a property
    // nobody documented is the same problem from the other side.
    expect(source.additionalProperties).toBe(false);

    const descriptor = schemas().SeriesDescriptor;
    expect(descriptor.required).toContain('source');
    expect((descriptor.properties as Record<string, JsonSchema>).source.$ref).toBe(
      '#/components/schemas/SeriesSource'
    );
  });

  it('is required on every catalogue entry as well as on every series', () => {
    // §8.1's case: a catalogue that told you a zone existed without telling you
    // whose data it was would push the licence question back onto the customer
    // at the moment they are deciding what to buy.
    for (const name of ['CatalogModel', 'CatalogCoverage'] as const) {
      expect(schemas()[name].required as string[], name).toContain('source');
    }
    const stream = (schemas().CatalogZone.properties as Record<string, JsonSchema>).streams;
    expect(((stream.items as JsonSchema).required as string[])).toContain('source');
  });

  it('is required on the series block of every response that carries data', () => {
    const withSeries = [
      'ObservationsLoadResponse',
      'ObservationsPriceResponse',
      'ObservationsGenerationResponse',
      'ForecastsResponse',
      'ForecastsLatestResponse',
      'AccuracyResponse',
    ] as const;

    for (const name of withSeries) {
      const meta = (schemas()[name].properties as Record<string, JsonSchema>).meta;
      expect(meta.required as string[], name).toContain('series');

      const series = (meta.properties as Record<string, JsonSchema>).series;
      expect((series.items as JsonSchema).$ref, name).toBe(
        '#/components/schemas/SeriesDescriptor'
      );
      // At least one entry: a `series: []` would satisfy "the field is present"
      // while carrying no licence for anything.
      expect(series.minItems, name).toBe(1);
    }
  });

  it('arrives on every series of every data response, exactly as the constants define it', async () => {
    const checks: ReadonlyArray<{ request: string; expected: typeof ENTSOE_OBSERVATION }> = [
      { request: '/v1/observations/load?zone=DE&from=2026-08-12&to=2026-08-13', expected: ENTSOE_OBSERVATION },
      { request: '/v1/observations/price?zone=DE&from=2026-08-12&to=2026-08-13', expected: ENTSOE_OBSERVATION },
      { request: '/v1/observations/generation?zone=DE&from=2026-08-12&to=2026-08-13', expected: ENTSOE_OBSERVATION },
      { request: '/v1/forecasts?zone=DE&type=load&from=2026-08-12&to=2026-08-13', expected: ABLE_FORECAST },
      { request: '/v1/forecasts/latest?zone=DE&type=load', expected: ABLE_FORECAST },
      { request: '/v1/accuracy?zone=DE&type=load&from=2026-08-11&to=2026-08-12', expected: ABLE_FORECAST },
    ];

    for (const { request, expected } of checks) {
      const { body } = await get(request);
      const series = (body as { meta: { series: Array<{ source: unknown }> } }).meta.series;
      expect(series.length, request).toBeGreaterThan(0);
      for (const entry of series) expect(entry.source, request).toEqual(expected);
    }
  });

  it('arrives on every catalogue entry too', async () => {
    const zones = (await get('/v1/catalog/zones')).body as {
      data: Array<{ streams: Array<{ source: unknown }> }>;
    };
    expect(zones.data.length).toBeGreaterThan(0);
    for (const zone of zones.data) {
      for (const stream of zone.streams) expect(stream.source).toEqual(ENTSOE_OBSERVATION);
    }

    const models = (await get('/v1/catalog/models')).body as { data: Array<{ source: unknown }> };
    expect(models.data.length).toBeGreaterThan(0);
    for (const entry of models.data) expect(entry.source).toEqual(ABLE_FORECAST);

    const coverage = (await get('/v1/catalog/coverage?zone=DE&stream=load')).body as {
      data: Array<{ source: unknown }>;
    };
    expect(coverage.data[0].source).toEqual(ENTSOE_OBSERVATION);
  });

  it('cannot silently disappear — the check fails when it does', async () => {
    // The negative control that makes every assertion above load-bearing. If
    // the schema did not require `source`, or the validator did not enforce
    // `required`, this would pass with an empty problem list and the whole
    // block would be decoration.
    const { body } = await get('/v1/observations/load?zone=DE&from=2026-08-12&to=2026-08-13');
    const mangled = JSON.parse(JSON.stringify(body)) as {
      meta: { series: Array<Record<string, unknown>> };
    };
    delete mangled.meta.series[0].source;

    const problems = validateAgainstSchema(
      DOCUMENT,
      responseSchema('/v1/observations/load', '200'),
      mangled
    );
    expect(problems).toEqual([
      { path: 'meta.series[0].source', message: 'required property is missing' },
    ]);
  });

  it('cannot silently lose one of its own fields either', async () => {
    const { body } = await get('/v1/observations/load?zone=DE&from=2026-08-12&to=2026-08-13');
    const mangled = JSON.parse(JSON.stringify(body)) as {
      meta: { series: Array<{ source: Record<string, unknown> }> };
    };
    // `attribution` is the field a subscriber renders. Dropping it while keeping
    // the block would look like a working attribution field to anything that
    // only checked the block was present.
    delete mangled.meta.series[0].source.attribution;

    expect(
      validateAgainstSchema(DOCUMENT, responseSchema('/v1/observations/load', '200'), mangled)
    ).toEqual([
      { path: 'meta.series[0].source.attribution', message: 'required property is missing' },
    ]);
  });
});

describe('an undocumented field fails, in every direction', () => {
  it('rejects a field the document does not declare', async () => {
    const { body } = await get('/v1/observations/load?zone=DE&from=2026-08-12&to=2026-08-13');
    const mangled = JSON.parse(JSON.stringify(body)) as { meta: Record<string, unknown> };
    mangled.meta.confidence = 0.9;

    expect(
      validateAgainstSchema(DOCUMENT, responseSchema('/v1/observations/load', '200'), mangled)
    ).toEqual([
      { path: 'meta.confidence', message: 'property is not declared in the published schema' },
    ]);
  });

  it('rejects a documented field that changed type', async () => {
    const { body } = await get('/v1/observations/load?zone=DE&from=2026-08-12&to=2026-08-13');
    const mangled = JSON.parse(JSON.stringify(body)) as { meta: Record<string, unknown> };
    // The row cap arriving as a string is the shape of a real regression — a
    // number rendered through a template — and it is invisible to a check that
    // only compares key names.
    mangled.meta.row_limit = '10000';

    expect(
      validateAgainstSchema(DOCUMENT, responseSchema('/v1/observations/load', '200'), mangled)
    ).toEqual([
      { path: 'meta.row_limit', message: 'expected type integer, got string "10000"' },
    ]);
  });
});

describe('the error contract', () => {
  it('every documented error response uses the one Error schema', () => {
    // What makes 403 and 429 covered without being exercised: they cannot drift
    // away from the envelope validated below without this failing.
    for (const [path, item] of Object.entries(DOCUMENT.paths)) {
      const responses = (item as { get: { responses: Record<string, unknown> } }).get.responses;
      for (const [status, response] of Object.entries(responses)) {
        if (status.startsWith('2')) continue;
        const schema = (response as { content: Record<string, { schema: JsonSchema }> }).content[
          'application/json'
        ].schema;
        expect(schema.$ref, `${path} ${status}`).toBe('#/components/schemas/Error');
      }
    }
  });

  it.each([
    ['/v1/observations/load?from=2026-08-12&to=2026-08-13', 'zone_required'],
    ['/v1/observations/load?zone=DE&to=2026-08-13', 'window_required'],
    ['/v1/observations/load?zone=DE&from=2019-01-01&to=2026-08-13', 'window_too_large'],
    ['/v1/forecasts?zone=DE&from=2026-08-12&to=2026-08-13', 'type_required'],
    ['/v1/forecasts?zone=DE&type=net_position&from=2026-08-12&to=2026-08-13', 'invalid_type'],
    ['/v1/catalog/coverage?zone=DE', 'stream_required'],
  ])('%s answers a 400 that matches the published Error schema', async (request, code) => {
    const { status, body } = await get(request);
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe(code);

    const path = request.split('?')[0];
    expectValid(responseSchema(path, '400'), body, request);
  });

  it('a 404 matches it too', async () => {
    const { status, body } = await get('/v1/observations/net-position?zone=DE');
    expect(status).toBe(404);
    // Documented on every operation, so any of them is the right schema to
    // check a catch-all 404 against.
    expectValid(responseSchema('/v1/observations/load', '404'), body, '404');
  });

  it('a real 401 from the key gate matches it', async () => {
    // Mounted here rather than in the shared app above, because the other tests
    // would then have to thread a key through every request and a gate failure
    // would read as a contract failure.
    const gated = express();
    gated.use('/v1', requireApiKey({ directory: createMemoryApiKeyDirectory().directory }));
    gated.use('/v1', createV1Routes(createMemoryDataContext(source, { now: () => NOW })));
    gated.use(publicNotFoundHandler);
    gated.use(publicErrorHandler);

    const server: Server = await new Promise((resolve) => {
      const s = gated.listen(0, '127.0.0.1', () => resolve(s));
    });
    const address = server.address() as { port: number };
    try {
      const res = await fetch(
        `http://127.0.0.1:${address.port}/v1/observations/load?zone=DE&from=2026-08-12&to=2026-08-13`
      );
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
      expectValid(responseSchema('/v1/observations/load', '401'), await res.json(), '401');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('documented parameters behave as documented', () => {
  // Not shape drift but *grammar* drift: a parameter the document says is
  // required that the implementation defaults, or an enum the implementation
  // has quietly widened, is a contract a client would write against and lose.

  const parametersOf = (path: string): Array<{ name: string; required?: boolean; schema: JsonSchema }> =>
    (DOCUMENT.paths as Record<string, { get: { parameters: Array<{ name: string; required?: boolean; schema: JsonSchema }> } }>)[
      path
    ].get.parameters;

  it('required parameters are actually required', async () => {
    const complete: Record<string, Record<string, string>> = {
      '/v1/observations/load': { zone: 'DE', from: '2026-08-12', to: '2026-08-13' },
      '/v1/observations/price': { zone: 'DE', from: '2026-08-12', to: '2026-08-13' },
      '/v1/observations/generation': { zone: 'DE', from: '2026-08-12', to: '2026-08-13' },
      '/v1/forecasts': { zone: 'DE', type: 'load', from: '2026-08-12', to: '2026-08-13' },
      '/v1/forecasts/latest': { zone: 'DE', type: 'load' },
      '/v1/accuracy': { zone: 'DE', type: 'load', from: '2026-08-11', to: '2026-08-12' },
      '/v1/catalog/coverage': { zone: 'DE', stream: 'load' },
    };

    for (const [path, params] of Object.entries(complete)) {
      const required = parametersOf(path)
        .filter((parameter) => parameter.required === true)
        .map((parameter) => parameter.name);
      expect(required.sort(), path).toEqual(Object.keys(params).sort());

      for (const omitted of required) {
        const query = Object.entries(params)
          .filter(([name]) => name !== omitted)
          .map(([name, value]) => `${name}=${value}`)
          .join('&');
        const { status } = await get(`${path}?${query}`);
        expect(status, `${path} without ${omitted}`).toBe(400);
      }
    }
  });

  it('enumerated parameters refuse a value outside the published enum', async () => {
    const offEnum: ReadonlyArray<{ path: string; query: string; parameter: string }> = [
      { path: '/v1/forecasts', query: 'zone=DE&type=load&model=lightgbm&from=2026-08-12&to=2026-08-13', parameter: 'model' },
      { path: '/v1/accuracy', query: 'zone=DE&type=renewable&from=2026-08-11&to=2026-08-12', parameter: 'type' },
      { path: '/v1/catalog/coverage', query: 'zone=DE&stream=net_position', parameter: 'stream' },
      {
        path: '/v1/observations/generation',
        query: 'zone=DE&from=2026-08-12&to=2026-08-13&production_type=nucular',
        parameter: 'production_type',
      },
    ];

    for (const { path, query, parameter } of offEnum) {
      // The value is outside the published enum, so the published enum has to
      // be the one the implementation enforces.
      const declared = parametersOf(path).find((entry) => entry.name === parameter);
      expect(declared, `${path} does not document ${parameter}`).toBeDefined();

      const { status } = await get(`${path}?${query}`);
      expect(status, `${path}?${query}`).toBe(400);
    }
  });

  it('the documented row cap is the one applied', async () => {
    const limit = parametersOf('/v1/observations/load').find((entry) => entry.name === 'limit');
    const { body } = await get('/v1/observations/load?zone=DE&from=2026-08-10&to=2026-08-13');
    expect((body as { meta: { row_limit: number } }).meta.row_limit).toBe(limit?.schema.maximum);
  });
});
