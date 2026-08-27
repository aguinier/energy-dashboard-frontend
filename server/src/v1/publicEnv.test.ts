import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_PUBLIC_ENV,
  assertPublicEnvironment,
  forbiddenPublicEnvPresent,
  parsePublicCorsOrigins,
} from './publicEnv.js';

describe('forbiddenPublicEnvPresent', () => {
  it('finds nothing in a clean environment', () => {
    expect(forbiddenPublicEnvPresent({})).toEqual([]);
    expect(forbiddenPublicEnvPresent({ PORT: '3002', ENERGY_DB_PATH: '/data/x.db' })).toEqual([]);
  });

  it('names HELIO_WRITE_TOKEN — the one the issue calls out by name', () => {
    expect(forbiddenPublicEnvPresent({ HELIO_WRITE_TOKEN: 'tok' })).toEqual(['HELIO_WRITE_TOKEN']);
  });

  it('covers the ops and git-state capabilities too', () => {
    const all: Record<string, string> = {};
    for (const name of FORBIDDEN_PUBLIC_ENV) all[name] = 'x';
    expect(forbiddenPublicEnvPresent(all)).toEqual([...FORBIDDEN_PUBLIC_ENV]);
  });

  it('treats an explicitly empty value as absent', () => {
    // A compose file neutralises an inherited variable with `HELIO_WRITE_TOKEN=`
    // far more readably than it unsets one, and an empty token is not a
    // capability: writeAuth rejects every request when it is falsy
    // (`middleware/writeAuth.ts:16-23`).
    expect(forbiddenPublicEnvPresent({ HELIO_WRITE_TOKEN: '' })).toEqual([]);
  });

  it('does not treat a lookalike name as forbidden', () => {
    expect(forbiddenPublicEnvPresent({ HELIO_WRITE_TOKEN_PATH: 'x', COMMIT_SHA_SHORT: 'y' })).toEqual([]);
  });

  it('catches PAPERCLIP_API_KEY — the credential the breach watcher runs on (ABL-591)', () => {
    // The one entry here that is not a dashboard capability. ABL-578 put the
    // breach watcher in the private process so that the process ABL-291 may
    // expose could not reach the alarm describing whoever took it; before this
    // entry, one shared docker/.env would have handed the public process that
    // credential silently.
    expect(forbiddenPublicEnvPresent({ PAPERCLIP_API_KEY: 'able_secret' })).toEqual([
      'PAPERCLIP_API_KEY',
    ]);
  });

  it('leaves the Paperclip address and identifiers alone', () => {
    // Deliberate, not an oversight: without the key these authorise nothing, and
    // forbidding a setting rather than a capability only breaks deployments.
    expect(
      forbiddenPublicEnvPresent({
        PAPERCLIP_API_URL: 'http://192.168.86.237:3100',
        PAPERCLIP_COMPANY_ID: 'c',
        PAPERCLIP_PROJECT_ID: 'p',
      })
    ).toEqual([]);
  });
});

describe('assertPublicEnvironment', () => {
  it('passes a clean environment', () => {
    expect(() => assertPublicEnvironment({ PUBLIC_PORT: '3002' })).not.toThrow();
  });

  it('names every offender, not just the first', () => {
    try {
      assertPublicEnvironment({ HELIO_WRITE_TOKEN: 'a', OPS_PEER_URL: 'http://peer' });
      expect.unreachable('should have thrown');
    } catch (err) {
      const { message } = err as Error;
      expect(message).toContain('HELIO_WRITE_TOKEN');
      expect(message).toContain('OPS_PEER_URL');
    }
  });

  it('never includes a value', () => {
    // The whole reason this is a list of names and not a dump of the bag.
    try {
      assertPublicEnvironment({ HELIO_WRITE_TOKEN: 'hunter2', OPS_PEER_URL: 'http://internal-peer.lan' });
      expect.unreachable('should have thrown');
    } catch (err) {
      const { message } = err as Error;
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain('internal-peer.lan');
    }
  });

  it('reads as a sentence in both the one and the many case', () => {
    expect(() => assertPublicEnvironment({ COMMIT_SHA: 'abc' })).toThrow(/COMMIT_SHA is set/);
    expect(() => assertPublicEnvironment({ COMMIT_SHA: 'abc', OPS_PEER_URL: 'u' })).toThrow(/are set/);
  });
});

describe('parsePublicCorsOrigins', () => {
  it('defaults to deny — unset, empty, and whitespace all yield no allowed origin', () => {
    expect(parsePublicCorsOrigins(undefined)).toEqual([]);
    expect(parsePublicCorsOrigins('')).toEqual([]);
    expect(parsePublicCorsOrigins('   ,  , ')).toEqual([]);
  });

  it('splits and trims a list', () => {
    expect(parsePublicCorsOrigins('https://a.example.com, https://b.example.com')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('strips a trailing slash, which an Origin header never carries', () => {
    // Configured with one, this would match nothing and fail at request time
    // rather than at parse time — the silent kind of misconfiguration.
    expect(parsePublicCorsOrigins('https://a.example.com/')).toEqual(['https://a.example.com']);
  });

  it('collapses duplicates', () => {
    expect(parsePublicCorsOrigins('https://a.example.com,https://a.example.com/')).toEqual([
      'https://a.example.com',
    ]);
  });

  it('keeps a port, which is part of an origin', () => {
    expect(parsePublicCorsOrigins('http://localhost:5173')).toEqual(['http://localhost:5173']);
  });

  it('does not special-case a wildcard', () => {
    // `*` is not expanded into "allow everything": it is passed through as a
    // literal that matches no Origin header. Allowing every origin on a
    // metered, key-authenticated API should require a code change and a
    // reviewer, not a character in a config file.
    expect(parsePublicCorsOrigins('*')).toEqual(['*']);
  });
});
