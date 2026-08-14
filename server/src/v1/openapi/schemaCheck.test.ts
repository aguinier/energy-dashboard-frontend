import { describe, it, expect } from 'vitest';
import { validateAgainstSchema, formatProblems, type JsonSchema } from './schemaCheck.js';

/**
 * The control on the control.
 *
 * `drift.test.ts` is only worth running if this validator actually rejects
 * things. A validator that returns `[]` for every input passes every drift
 * check ever written, reports a green suite, and lets the published contract
 * and the implementation walk apart in silence — which is the exact failure
 * ABL-305 exists to prevent, wearing a passing test as a disguise.
 *
 * So every assertion here is a **rejection**. The acceptance cases are the ones
 * in `drift.test.ts`, against real response bodies.
 */

const ROOT = {
  components: {
    schemas: {
      Source: {
        type: 'object',
        properties: {
          id: { type: 'string', enum: ['entsoe', 'able'] },
          attribution: { type: ['string', 'null'] },
        },
        required: ['id', 'attribution'],
        additionalProperties: false,
      },
      Series: {
        type: 'object',
        properties: { field: { type: 'string' }, source: { $ref: '#/components/schemas/Source' } },
        required: ['field', 'source'],
        additionalProperties: false,
      },
    },
  },
};

const SERIES: JsonSchema = { $ref: '#/components/schemas/Series' };

function problems(schema: JsonSchema, value: unknown): string[] {
  return validateAgainstSchema(ROOT, schema, value).map((problem) => `${problem.path}: ${problem.message}`);
}

describe('required', () => {
  it('rejects a missing property, naming its path', () => {
    expect(problems(SERIES, { field: 'load' })).toEqual(['source: required property is missing']);
  });

  it('rejects one missing inside a $ref, with the full path', () => {
    expect(problems(SERIES, { field: 'load', source: { id: 'entsoe' } })).toEqual([
      'source.attribution: required property is missing',
    ]);
  });

  it('accepts a property that is present and null', () => {
    // The distinction this API leans on everywhere: `null` is an answer, absent
    // is a dropped field. A validator that conflated them would report the
    // NULL contract as a violation on every generation response.
    expect(problems(SERIES, { field: 'load', source: { id: 'able', attribution: null } })).toEqual([]);
  });
});

describe('additionalProperties: false', () => {
  it('rejects a field nobody declared', () => {
    expect(
      problems(SERIES, { field: 'load', source: { id: 'able', attribution: null }, confidence: 1 })
    ).toEqual(['confidence: property is not declared in the published schema']);
  });
});

describe('types', () => {
  it.each([
    [{ type: 'string' }, 4, 'expected type string, got number 4'],
    [{ type: 'integer' }, 1.5, 'expected type integer, got number 1.5'],
    [{ type: 'number' }, '3', 'expected type number, got string "3"'],
    [{ type: 'boolean' }, 'true', 'expected type boolean, got string "true"'],
    [{ type: 'array' }, {}, 'expected type array, got object'],
    [{ type: 'object' }, [], 'expected type object, got array(0)'],
    [{ type: 'null' }, 0, 'expected type null, got number 0'],
    [{ type: ['string', 'null'] }, 7, 'expected type string | null, got number 7'],
  ])('%o rejects %o', (schema, value, message) => {
    expect(problems(schema as JsonSchema, value)).toEqual([`(root): ${message}`]);
  });

  it('rejects NaN as a number, because JSON cannot carry one', () => {
    expect(problems({ type: 'number' }, Number.NaN)).toHaveLength(1);
  });
});

describe('enum and const', () => {
  it('rejects a value outside the enum', () => {
    expect(problems({ enum: ['ok', 'no_data'] }, 'upstream_gap')).toEqual([
      '(root): expected one of ["ok","no_data"], got string "upstream_gap"',
    ]);
  });

  it('rejects a value that is not the const', () => {
    expect(problems({ type: 'string', const: 'observations.load' }, 'observations.price')).toEqual([
      '(root): expected "observations.load", got string "observations.price"',
    ]);
  });
});

describe('arrays', () => {
  it('validates each item and names its index', () => {
    expect(problems({ type: 'array', items: SERIES }, [{ field: 'a', source: { id: 'able', attribution: null } }, { field: 'b' }])).toEqual(
      ['[1].source: required property is missing']
    );
  });

  it('rejects an empty array where at least one item is promised', () => {
    // `meta.series: []` would satisfy "the field is present" while carrying a
    // licence for nothing, which is why the series schemas set `minItems: 1`.
    expect(problems({ type: 'array', minItems: 1, items: SERIES }, [])).toEqual([
      '(root): expected at least 1 items, got 0',
    ]);
  });
});

describe('the validator refuses to pretend', () => {
  // The design rule from the module note: an unimplemented keyword is an error,
  // not a skip. `ajv`'s default is the opposite, and that default is how a
  // schema keyword quietly stops constraining anything.

  it('throws on a keyword it does not implement', () => {
    expect(() => problems({ oneOf: [{ type: 'string' }] }, 'x')).toThrow(/oneOf.*not implemented/s);
  });

  it('throws on an unresolvable $ref rather than passing', () => {
    expect(() => problems({ $ref: '#/components/schemas/Nope' }, {})).toThrow(/unresolved \$ref/);
  });

  it('throws on a remote $ref', () => {
    expect(() => problems({ $ref: 'https://example.com/schema.json' }, {})).toThrow(
      /only #\/components\/schemas/
    );
  });

  it('throws on a $ref carrying constraining siblings it would have to merge', () => {
    expect(() => problems({ $ref: '#/components/schemas/Source', required: ['x'] }, {})).toThrow(
      /sibling keywords/
    );
  });

  it('allows a $ref to carry a description, which constrains nothing', () => {
    expect(
      problems(
        { $ref: '#/components/schemas/Source', description: 'the ToS §7.3 field' },
        { id: 'able', attribution: null }
      )
    ).toEqual([]);
  });
});

describe('reporting', () => {
  it('collects every problem rather than stopping at the first', () => {
    // Three test runs to find three missing fields is two runs too many.
    expect(problems(SERIES, { source: { id: 'nope' } })).toHaveLength(3);
  });

  it('formats problems one per line for a failure message', () => {
    expect(formatProblems(validateAgainstSchema(ROOT, SERIES, {}))).toBe(
      '  field: required property is missing\n  source: required property is missing'
    );
  });
});
