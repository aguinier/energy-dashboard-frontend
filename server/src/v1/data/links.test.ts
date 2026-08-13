import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLink, resolvePublicBaseUrl } from './links.js';

/**
 * Trap 1 from the ABL-291 brief, checked from both sides.
 *
 * The behavioural half is below: what a link looks like with and without
 * configuration. The **structural** half is the last describe block, and it is
 * the one that matters — it asserts there is no line anywhere in `v1/data/` or
 * `v1/routes/` that could read a host off a request.
 *
 * That distinction is the same one `publicAppGraph.test.ts` makes about the
 * internal routes: a behavioural test proves today's links are clean, and a
 * source test proves the capability is absent. `${req.protocol}://${req.get('host')}`
 * is what every framework tutorial writes, it works perfectly on the LAN, and
 * the failure it produces — `http://192.168.86.36:3002/…` stored in a
 * subscriber's client — is only discovered after the API moves.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('resolvePublicBaseUrl', () => {
  it('is null when unset, which means relative links', () => {
    expect(resolvePublicBaseUrl({})).toBeNull();
    expect(resolvePublicBaseUrl({ PUBLIC_BASE_URL: '   ' })).toBeNull();
  });

  it('keeps a path prefix, because a gateway may mount us under one', () => {
    expect(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://api.example.com/energy' })).toBe(
      'https://api.example.com/energy'
    );
  });

  it('strips a trailing slash so joining is unambiguous', () => {
    expect(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://api.example.com///' })).toBe(
      'https://api.example.com'
    );
  });

  it('refuses configuration it would silently not honour', () => {
    // A query string would be discarded the moment pagination appends its own,
    // so accepting it would mean accepting a setting that does nothing.
    expect(() => resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://api.example.com?v=1' })).toThrow(
      /query string/
    );
    expect(() => resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'not a url' })).toThrow(/absolute URL/);
    expect(() => resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'ftp://example.com' })).toThrow(/http/);
  });

  it('fails at startup rather than on page two', () => {
    // The failure mode this ordering avoids: a base URL that is only exercised
    // when a result happens to be truncated reaches a customer before it
    // reaches us. `publicIndex.ts` calls this before `listen`.
    expect(() => resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://' })).toThrow();
  });
});

describe('buildLink', () => {
  it('omits absent parameters rather than serialising undefined', () => {
    expect(buildLink(null, '/v1/observations/load', { zone: 'DE', cursor: undefined })).toBe(
      '/v1/observations/load?zone=DE'
    );
  });

  it('encodes values', () => {
    expect(buildLink(null, '/v1/observations/load', { from: '2026-08-01T00:00:00Z' })).toBe(
      '/v1/observations/load?from=2026-08-01T00%3A00%3A00Z'
    );
  });

  it('prefixes the configured base and nothing else', () => {
    expect(buildLink('https://api.example.com', '/v1/catalog/zones', {})).toBe(
      'https://api.example.com/v1/catalog/zones'
    );
  });
});

describe('no module under v1/data or v1/routes can read a host off a request', () => {
  /** Every non-test source file in the two directories the links come from. */
  function sources(dir: string): string[] {
    return fs
      .readdirSync(path.join(HERE, '..', dir))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => `${dir}/${name}`);
  }

  const FILES = [...sources('data'), ...sources('routes')];

  /**
   * Strip comments before scanning.
   *
   * Not a loophole — the opposite. `links.ts` **quotes** the forbidden idiom in
   * its own doc comment, because the whole point of that module is to explain
   * why `${req.protocol}://${req.get('host')}` must not be written. A scan that
   * failed a file for documenting the trap would push the next author to delete
   * the explanation rather than the code, which is exactly backwards.
   *
   * Same regexes `importGraph.ts` uses, and the same trade-off: they err toward
   * *keeping* text, so anything they fail to strip can only make this check
   * stricter.
   */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  }

  // Each pattern is a way the mistake is actually written. `req.get('host')` and
  // `req.header('host')` are the Express idioms; `req.hostname` and
  // `req.protocol` are the properties behind them; `originalUrl` is the
  // near-miss that looks safe (it is path-and-query only) but is how a
  // half-built absolute URL usually starts.
  const FORBIDDEN = [
    /\breq\.hostname\b/,
    /\breq\.protocol\b/,
    /\breq\.originalUrl\b/,
    /\breq\.headers\s*(\.|\[)\s*['"]?host/i,
    /\.get\(\s*['"]host['"]\s*\)/i,
    /\.header\(\s*['"]host['"]\s*\)/i,
    /\bx-forwarded-(host|proto)\b/i,
  ];

  it.each(FILES)('%s', (file) => {
    const source = stripComments(fs.readFileSync(path.join(HERE, '..', file), 'utf8'));
    for (const pattern of FORBIDDEN) {
      expect(source).not.toMatch(pattern);
    }
  });

  it('would catch the mistake if somebody wrote it', () => {
    // A scan nobody has seen fail is a scan nobody knows works. This is the
    // line the next author would actually write, run through the same filter.
    const tempting = "const next = `${req.protocol}://${req.get('host')}${req.originalUrl}`;";
    expect(FORBIDDEN.some((pattern) => pattern.test(stripComments(tempting)))).toBe(true);
  });

  it('covers every file it should — the list is read from disk, not typed out', () => {
    // A scan that silently covered nothing would pass forever. This is the same
    // argument `importGraph.ts` makes about `unresolved`: a control that
    // under-reports is worse than no control.
    expect(FILES.length).toBeGreaterThanOrEqual(14);
    expect(FILES).toContain('routes/observations.ts');
    expect(FILES).toContain('data/links.ts');
  });
});
