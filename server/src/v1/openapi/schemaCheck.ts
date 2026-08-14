/**
 * A JSON Schema validator small enough to read, strict enough to be worth
 * running, and loud about what it does not understand.
 *
 * ## Why this is hand-written rather than `ajv`
 *
 * The drift check (`drift.test.ts`) validates **real response bodies** against
 * the published schemas. That needs a validator, and the obvious move is to add
 * `ajv`. Two reasons not to:
 *
 * 1. The server's dependency list is five runtime packages and six dev ones, and
 *    the public process's package graph is asserted module-by-module
 *    (`publicAppGraph.test.ts`). A validator is ~120 lines of the subset we
 *    actually use; a dependency is a supply-chain edge on a paid public surface
 *    for code we can read in one sitting.
 * 2. `ajv` in its default mode **ignores keywords it does not know**. That is
 *    the wrong failure for a drift check: a schema keyword that silently does
 *    nothing is a check that silently stops checking, and the whole point of
 *    ABL-305 is that a spec nobody verifies is worse than no spec.
 *
 * So this one inverts that default. {@link validateAgainstSchema} **throws** on
 * a keyword it does not implement, rather than skipping it. Adding `oneOf` to
 * the document is then a failing test that says "this validator does not
 * implement oneOf" — a five-minute decision — instead of a quiet weakening
 * nobody notices for a year.
 *
 * ## The two directions of shape drift, and how each is caught
 *
 * - **The implementation stopped emitting a field the spec promises.** Caught by
 *   `required`. This is the direction ABL-297 cares about: ToS §7.3's per-series
 *   `source` field is `required` at every level it appears, so a response that
 *   drops it fails here rather than in a subscriber's attribution pipeline.
 * - **The implementation emits a field the spec does not document.** Caught by
 *   `additionalProperties: false`, which every object schema in the document
 *   sets. An undocumented field is a field integrators do not know to read and
 *   one we have not committed to keeping — it should be a deliberate diff.
 *
 * `schemaCheck.test.ts` is the negative control: it asserts this module actually
 * *rejects* each of those, because a validator that returns `[]` for everything
 * passes every drift check ever written.
 */

/** One reason a value failed, and where in the value it was. */
export interface SchemaProblem {
  /** Dotted path from the validation root — `meta.series[0].source.licence`. */
  path: string;
  message: string;
}

export type JsonSchema = Record<string, unknown>;

/** The document a `$ref` resolves against. Only `#/components/schemas/*` is supported. */
export interface SchemaRoot {
  components?: { schemas?: Record<string, JsonSchema> };
}

/**
 * Keywords that carry no constraint and are skipped on purpose.
 *
 * Listed rather than pattern-matched so that the *unknown*-keyword throw below
 * stays meaningful: everything is either implemented, deliberately inert, or an
 * error.
 *
 * `format` is inert here deliberately. OpenAPI `format: date-time` is
 * annotation, not validation, and the timestamp grammar this API actually
 * promises is narrower than RFC 3339 — second precision, always `Z`. That is
 * asserted directly against response bodies in `drift.test.ts` with the regex
 * the contract states, rather than approximated by a format name.
 */
const INERT_KEYWORDS: ReadonlySet<string> = new Set([
  'description',
  'title',
  'summary',
  'example',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'externalDocs',
  'format',
  '$comment',
  'xml',
]);

const IMPLEMENTED_KEYWORDS: ReadonlySet<string> = new Set([
  '$ref',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
]);

/**
 * Validate `value` against `schema`, resolving `$ref` against `root`.
 *
 * Returns every problem found rather than the first: a drift failure that names
 * one missing field, is fixed, and then names the next one is three test runs
 * where one would do.
 *
 * @throws if the schema uses a keyword this module does not implement.
 */
export function validateAgainstSchema(
  root: SchemaRoot,
  schema: JsonSchema,
  value: unknown,
  path = ''
): SchemaProblem[] {
  const resolved = resolveRef(root, schema, path);
  assertKeywordsSupported(resolved, path);

  const problems: SchemaProblem[] = [];

  if (resolved.enum !== undefined) {
    const allowed = resolved.enum as unknown[];
    if (!allowed.some((candidate) => Object.is(candidate, value))) {
      problems.push({
        path: label(path),
        message: `expected one of ${JSON.stringify(allowed)}, got ${describe(value)}`,
      });
      // A value outside the enum will fail every other keyword too; one problem
      // is the useful report.
      return problems;
    }
  }

  if (resolved.const !== undefined && !Object.is(resolved.const, value)) {
    problems.push({
      path: label(path),
      message: `expected ${JSON.stringify(resolved.const)}, got ${describe(value)}`,
    });
    return problems;
  }

  if (resolved.type !== undefined) {
    const accepted = (Array.isArray(resolved.type) ? resolved.type : [resolved.type]) as string[];
    if (!accepted.some((name) => matchesType(name, value))) {
      problems.push({
        path: label(path),
        message: `expected type ${accepted.join(' | ')}, got ${describe(value)}`,
      });
      // Structural keywords below assume the type held. Reporting "missing
      // property x" against a string is noise on top of the real failure.
      return problems;
    }
  }

  if (isPlainObject(value)) {
    problems.push(...checkObject(root, resolved, value, path));
  }

  if (Array.isArray(value)) {
    problems.push(...checkArray(root, resolved, value, path));
  }

  return problems;
}

function checkObject(
  root: SchemaRoot,
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string
): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = (schema.required ?? []) as string[];

  for (const name of required) {
    // `hasOwnProperty`, not `=== undefined`: a field present and explicitly
    // `null` satisfies `required`, and this API leans on that distinction
    // everywhere — `nuclear: null` means "this zone does not report it" and is
    // a promise we keep, while an absent key means "we dropped it".
    if (!Object.prototype.hasOwnProperty.call(value, name)) {
      problems.push({ path: label(join(path, name)), message: 'required property is missing' });
    }
  }

  for (const [name, entry] of Object.entries(value)) {
    const propertySchema = properties[name];
    if (propertySchema !== undefined) {
      problems.push(...validateAgainstSchema(root, propertySchema, entry, join(path, name)));
      continue;
    }
    if (schema.additionalProperties === false) {
      problems.push({
        path: label(join(path, name)),
        message: 'property is not declared in the published schema',
      });
      continue;
    }
    if (isPlainObject(schema.additionalProperties)) {
      problems.push(
        ...validateAgainstSchema(
          root,
          schema.additionalProperties as JsonSchema,
          entry,
          join(path, name)
        )
      );
    }
  }

  return problems;
}

function checkArray(
  root: SchemaRoot,
  schema: JsonSchema,
  value: unknown[],
  path: string
): SchemaProblem[] {
  const problems: SchemaProblem[] = [];

  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    problems.push({
      path: label(path),
      message: `expected at least ${schema.minItems} items, got ${value.length}`,
    });
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    problems.push({
      path: label(path),
      message: `expected at most ${schema.maxItems} items, got ${value.length}`,
    });
  }

  if (isPlainObject(schema.items)) {
    value.forEach((entry, index) => {
      problems.push(
        ...validateAgainstSchema(root, schema.items as JsonSchema, entry, `${path}[${index}]`)
      );
    });
  }

  return problems;
}

/**
 * Resolve a `$ref`, refusing anything but a local component reference.
 *
 * A sibling keyword beside `$ref` is refused rather than merged. JSON Schema
 * 2020-12 does allow both, but "the ref plus this one override" is exactly the
 * kind of subtlety that makes a hand-written validator wrong in a way nobody
 * reads — and the published document never needs it.
 */
function resolveRef(root: SchemaRoot, schema: JsonSchema, path: string): JsonSchema {
  const ref = schema.$ref;
  if (ref === undefined) return schema;

  const siblings = Object.keys(schema).filter((key) => key !== '$ref' && !INERT_KEYWORDS.has(key));
  if (siblings.length > 0) {
    throw new Error(
      `${label(path)}: $ref carries sibling keywords (${siblings.join(', ')}), which this validator does not merge`
    );
  }
  if (typeof ref !== 'string' || !ref.startsWith('#/components/schemas/')) {
    throw new Error(`${label(path)}: only #/components/schemas/* refs are supported, got ${String(ref)}`);
  }

  const name = ref.slice('#/components/schemas/'.length);
  const target = root.components?.schemas?.[name];
  if (target === undefined) throw new Error(`${label(path)}: unresolved $ref ${ref}`);

  return resolveRef(root, target, path);
}

/**
 * The keyword allowlist — the reason this validator cannot quietly stop
 * checking.
 *
 * See the module note: an unimplemented keyword is an error, not a skip.
 */
function assertKeywordsSupported(schema: JsonSchema, path: string): void {
  for (const keyword of Object.keys(schema)) {
    if (IMPLEMENTED_KEYWORDS.has(keyword) || INERT_KEYWORDS.has(keyword)) continue;
    throw new Error(
      `${label(path)}: schema keyword "${keyword}" is not implemented by schemaCheck.ts. ` +
        'Implement it or express the constraint another way — silently ignoring it would ' +
        'weaken the drift check without failing anything.'
    );
  }
}

function matchesType(name: string, value: unknown): boolean {
  switch (name) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      // `Number.isFinite`, not `typeof === 'number'`: `NaN` and `Infinity` are
      // not representable in JSON, so a schema that accepted them would be
      // describing something this API cannot send.
      return typeof value === 'number' && Number.isFinite(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      throw new Error(`unknown schema type "${name}"`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function join(path: string, name: string): string {
  return path === '' ? name : `${path}.${name}`;
}

function label(path: string): string {
  return path === '' ? '(root)' : path;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return 'object';
  return `${typeof value} ${JSON.stringify(value)}`;
}

/** Render problems for a test failure message: one per line, path first. */
export function formatProblems(problems: readonly SchemaProblem[]): string {
  return problems.map((problem) => `  ${problem.path}: ${problem.message}`).join('\n');
}
