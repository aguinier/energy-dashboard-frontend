import { describe, it, expect } from 'vitest';
import { collectAccountContacts } from './accountContacts.js';
import { createMemoryApiKeyDirectory, type MemoryKeySeed } from './memoryApiKeyDirectory.js';
import { isPlausibleContactEmail, requireContactEmail, CONTACT_REQUIRED_MESSAGE } from './apiKeyStore.js';

/**
 * The ToS §9.3 recipient list (ABL-528).
 *
 * Records are built through `createMemoryApiKeyDirectory` rather than by hand,
 * for two reasons. It is the only way to construct the row this module exists
 * for — a key with **no contact at all**, which the real store refuses to
 * create and which can therefore only arrive from a file written before the
 * column existed. And it keeps the fake honest: if it ever stopped producing
 * the same record shape the SQLite store produces, these assertions would move
 * with it, which is the property `sqliteApiKeyStore.test.ts` cross-checks from
 * the other side.
 */

const NOW = new Date('2026-08-22T12:00:00.000Z');

function recordsFrom(seeds: MemoryKeySeed[]) {
  return createMemoryApiKeyDirectory(seeds).keys.map((k) => k.record);
}

describe('collectAccountContacts', () => {
  it('lists one recipient per address, with the keys and accounts behind it', () => {
    const keys = recordsFrom([
      { accountId: 'acct_a', contactEmail: 'ops@acme.example' },
      { accountId: 'acct_a', contactEmail: 'ops@acme.example' },
      { accountId: 'acct_b', contactEmail: 'data@beta.example' },
    ]);

    const set = collectAccountContacts(keys, NOW);

    expect(set.liveKeys).toBe(3);
    expect(set.unreachable).toEqual([]);
    expect(set.recipients).toHaveLength(2);
    expect(set.recipients[0]).toMatchObject({
      email: 'data@beta.example',
      accountIds: ['acct_b'],
    });
    expect(set.recipients[1]).toMatchObject({
      email: 'ops@acme.example',
      accountIds: ['acct_a'],
    });
    expect(set.recipients[1].keyIds).toHaveLength(2);
  });

  it('collects the accounts behind a shared address rather than repeating it', () => {
    // A consultancy holding keys for two of its clients is one person to email,
    // not two — but the notice has to be able to say which accounts it covers.
    const keys = recordsFrom([
      { accountId: 'acct_b', contactEmail: 'shared@ops.example' },
      { accountId: 'acct_a', contactEmail: 'shared@ops.example' },
    ]);

    const set = collectAccountContacts(keys, NOW);

    expect(set.recipients).toHaveLength(1);
    expect(set.recipients[0].accountIds).toEqual(['acct_a', 'acct_b']);
  });

  it('treats a difference of case as one recipient, and keeps the stored spelling', () => {
    const keys = recordsFrom([
      { contactEmail: 'Ops@Acme.example' },
      { contactEmail: 'ops@acme.example' },
    ]);

    const set = collectAccountContacts(keys, NOW);

    expect(set.recipients).toHaveLength(1);
    // The first spelling seen, not a lowercased one. `requireContactEmail`
    // stores what the operator typed because the local part is case-sensitive
    // by specification; deduplication is where the tidying belongs.
    expect(set.recipients[0].email).toBe('Ops@Acme.example');
  });

  describe('a key with no contact is reported, never dropped', () => {
    it('names the pre-column row instead of silently omitting it', () => {
      // The whole point of the module. A `string[]` of addresses would have
      // returned one entry here and looked complete.
      const keys = recordsFrom([
        { accountId: 'acct_a', contactEmail: 'ops@acme.example' },
        { accountId: 'acct_b', contactEmail: null, label: 'prod ETL' },
      ]);

      const set = collectAccountContacts(keys, NOW);

      expect(set.recipients).toHaveLength(1);
      expect(set.unreachable).toHaveLength(1);
      expect(set.unreachable[0]).toMatchObject({
        accountId: 'acct_b',
        label: 'prod ETL',
        reason: 'no_contact_recorded',
      });
      expect(set.unreachable[0].keyId).toBe(keys[1].id);
      // Counted as a live key either way: the denominator is how many
      // subscribers §9.3 covers, not how many we happen to be able to reach.
      expect(set.liveKeys).toBe(2);
    });

    it('treats a whitespace-only address the same as an absent one', () => {
      // Unreachable through the write path, reachable through a hand-edited
      // file — which is exactly when a silent pass would hurt.
      const set = collectAccountContacts(recordsFrom([{ contactEmail: '   ' }]), NOW);

      expect(set.recipients).toEqual([]);
      expect(set.unreachable).toHaveLength(1);
    });
  });

  describe('scope is live keys', () => {
    it('leaves out a revoked key: its holder is no longer a subscriber', () => {
      const keys = recordsFrom([
        { contactEmail: 'gone@acme.example', revokedAt: '2026-08-01T00:00:00.000Z' },
        { contactEmail: 'here@acme.example' },
      ]);

      const set = collectAccountContacts(keys, NOW);

      expect(set.liveKeys).toBe(1);
      expect(set.recipients.map((r) => r.email)).toEqual(['here@acme.example']);
    });

    it('leaves out an expired key, and takes a key back in before its deadline', () => {
      const keys = recordsFrom([{ contactEmail: 'ops@acme.example', expiresAt: '2026-08-10T00:00:00.000Z' }]);

      expect(collectAccountContacts(keys, NOW).recipients).toEqual([]);
      expect(collectAccountContacts(keys, new Date('2026-08-01T00:00:00.000Z')).recipients).toHaveLength(1);
    });

    it('does not report a revoked contactless key as unreachable', () => {
      // There is no live promise to keep, so listing it would be noise in the
      // one report that must stay readable.
      const keys = recordsFrom([{ contactEmail: null, revokedAt: '2026-08-01T00:00:00.000Z' }]);

      const set = collectAccountContacts(keys, NOW);
      expect(set).toEqual({ recipients: [], unreachable: [], liveKeys: 0 });
    });
  });

  it('says nothing rather than something when the store is empty', () => {
    expect(collectAccountContacts([], NOW)).toEqual({ recipients: [], unreachable: [], liveKeys: 0 });
  });
});

describe('isPlausibleContactEmail', () => {
  it.each([
    'ops@acme.example',
    'first.last+tag@sub.domain.co.uk',
    "o'brien@acme.example",
    'ops@acme-energy.example',
  ])('accepts %s', (value) => {
    expect(isPlausibleContactEmail(value)).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['no @ at all — an account id in the wrong flag', 'acct_7f3a9c21'],
    ['no local part', '@acme.example'],
    ['two @', 'ops@acme@example'],
    ['no dot in the domain', 'ops@localhost'],
    ['a trailing dot', 'ops@acme.'],
    ['a one-character TLD', 'ops@acme.x'],
    ['a shell-mangled pair', 'ops@acme.example other@acme.example'],
    ['an embedded newline', 'ops@acme.example\nrm -rf /'],
  ])('rejects %s', (_why, value) => {
    expect(isPlausibleContactEmail(value)).toBe(false);
  });

  it('rejects an address longer than SMTP carries', () => {
    const long = `${'a'.repeat(250)}@acme.example`;
    expect(long.length).toBeGreaterThan(254);
    expect(isPlausibleContactEmail(long)).toBe(false);
  });
});

describe('requireContactEmail', () => {
  it('trims, and returns the address unchanged otherwise', () => {
    // No lowercasing: rewriting what a person typed could change where a notice
    // lands, and the only thing it buys is a tidier comparison.
    expect(requireContactEmail('  Ops@Acme.example  ')).toBe('Ops@Acme.example');
  });

  it.each([undefined, null, '', '   '])('refuses %p with the §9.3 reason', (value) => {
    // The refusal has to argue for itself, the way scripts/backfillModelGuard.ts
    // does — an operator told "a flag is missing" adds a flag, and an operator
    // told what §9.3 promises knows which address to put in it.
    expect(() => requireContactEmail(value)).toThrow(CONTACT_REQUIRED_MESSAGE);
    expect(() => requireContactEmail(value)).toThrow(/§9\.3/);
    expect(() => requireContactEmail(value)).toThrow(/cannot reach/);
  });

  it('names the value it rejected, so a typo is visible', () => {
    expect(() => requireContactEmail('acct_7f3a9c21')).toThrow(/'acct_7f3a9c21' does not look like/);
  });
});
