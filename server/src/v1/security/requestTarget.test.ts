import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRequestTarget, UNRECOGNISED_TARGET, V1_ROUTE_TEMPLATES } from './requestTarget.js';

/**
 * The closed table, and the drift check that keeps it closed.
 *
 * Two claims, and the second is the one that stops this column rotting:
 *
 * 1. A caller-controlled path never reaches the record.
 * 2. The table really is every `/v1` route, checked against the route files
 *    rather than against somebody's memory.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(HERE, '../routes');

describe('classifying a refused request', () => {
  it.each(V1_ROUTE_TEMPLATES)('recognises %s', (template) => {
    // The gate sees the path with the `/v1` mount stripped, so the template is
    // re-derived from what Express actually hands the middleware.
    const gateRelative = template === '/v1' ? '/' : template.slice('/v1'.length);
    expect(classifyRequestTarget(gateRelative)).toBe(template);
  });

  it('tolerates one trailing slash, because Express’s own router does', () => {
    // `/v1/accuracy/` matches `/accuracy` in Express, so recording the two
    // differently would split one surface across two rows for no reason.
    expect(classifyRequestTarget('/accuracy/')).toBe('/v1/accuracy');
    expect(classifyRequestTarget('/catalog/zones/')).toBe('/v1/catalog/zones');
  });

  it('does not fold case — /v1/Accuracy is not a route this app serves', () => {
    // And a caller trying it is doing something a customer does not do, which is
    // worth being able to see.
    expect(classifyRequestTarget('/Accuracy')).toBe(UNRECOGNISED_TARGET);
  });

  it.each([
    { why: 'a traversal', path: '/%2e%2e%2f%2e%2e%2fetc%2fpasswd' },
    { why: 'a scanner probe', path: '/wp-login.php' },
    { why: 'an injected quote', path: "/observations/load'--" },
    { why: 'a very long path', path: `/${'a'.repeat(4096)}` },
    { why: 'a near-miss', path: '/observations/loads' },
    { why: 'a deeper path under a real one', path: '/catalog/zones/DE' },
  ])('records $why as unrecognised, never as the caller wrote it', ({ path: probed }) => {
    const target = classifyRequestTarget(probed);

    expect(target).toBe(UNRECOGNISED_TARGET);
    // The property that matters: nothing the caller chose survives into the
    // value. On this table the callers are by definition the ones we trust
    // least, and the record is kept for thirteen months.
    expect(target).toHaveLength(UNRECOGNISED_TARGET.length);
  });

  it('survives a path Express could not give it', () => {
    // Defensive rather than reachable — but `record()` runs inside the
    // authentication gate, and a throw here would turn a refusal into a 500 and
    // would differ per branch, which is exactly the observable difference the
    // recorder promises not to create.
    for (const odd of ['', undefined as unknown as string, null as unknown as string]) {
      expect(classifyRequestTarget(odd)).toBe(odd === '' ? '/v1' : '/v1');
    }
  });
});

describe('the table matches the routes that are actually mounted', () => {
  /**
   * Read the route files as text and rebuild the template set from them.
   *
   * Text rather than by importing `createV1Routes` and walking `router.stack`:
   * that shape is Express-internal and changes between majors, and importing the
   * routers drags a data context in. The same reasoning `publicAppGraph.test.ts`
   * gives for reading `publicApp.ts` rather than importing it.
   */
  function mountedTemplates(): string[] {
    const index = fs.readFileSync(path.join(ROUTES_DIR, 'index.ts'), 'utf8');
    const templates = new Set<string>(['/v1']);

    for (const mount of index.matchAll(/router\.use\('([^']+)',\s*(\w+)\(/g)) {
      const [, prefix, factory] = mount;
      const file = `${factory.replace(/Router$/, '')}.ts`;
      const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');

      for (const route of source.matchAll(/router\.get\((?:'([^']*)'|`([^`$]*)`)/g)) {
        const leaf = route[1] ?? route[2] ?? '';
        templates.add(`/v1${prefix}${leaf === '/' ? '' : leaf}`);
      }
      // `observations.ts` builds its leaves from a loop over the stream names,
      // which no regex over a literal can see. Rebuild that one from the same
      // list the loop iterates, so a fourth stream fails this test.
      for (const loop of source.matchAll(/router\.get\(`\/\$\{(\w+)\}`/g)) {
        const listed = new RegExp(`for \\(const ${loop[1]} of \\[([^\\]]+)\\]`).exec(source);
        for (const name of listed?.[1].matchAll(/'([^']+)'/g) ?? []) {
          templates.add(`/v1${prefix}/${name[1]}`);
        }
      }
    }
    return [...templates].sort();
  }

  it('is neither short nor long', () => {
    // A route added to `v1/routes/` and not added here would record as
    // `(unrecognised)` — safe, but it would quietly stop distinguishing a
    // scanner from a customer probing a real endpoint without a key.
    expect([...V1_ROUTE_TEMPLATES].sort()).toEqual(mountedTemplates());
  });

  it('found the routes at all, so a broken parse cannot pass this vacuously', () => {
    // The control on the control. If the regexes above stopped matching, both
    // sides would be `['/v1']` and the assertion would pass while checking
    // nothing.
    expect(mountedTemplates().length).toBeGreaterThanOrEqual(9);
    expect(mountedTemplates()).toContain('/v1/observations/load');
    expect(mountedTemplates()).toContain('/v1/forecasts/latest');
    expect(mountedTemplates()).toContain('/v1/accuracy');
  });
});
