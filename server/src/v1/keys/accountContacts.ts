import { isKeyLive, type ApiKeyRecord } from './apiKeyStore.js';

/**
 * Who a ToS §9.3 notice goes to, and who it cannot go to (ABL-528).
 *
 * §9.3 commits us to publishing a material model change "through the changelog
 * and to the account contact". `keyFormat`/`sqliteApiKeyStore` create the
 * address; this module answers the only question the notice mechanism will ask:
 * *given the key store as it stands, what is the recipient list?*
 *
 * ## Why a pure function over records rather than a store method
 *
 * It reads records and nothing else, so it needs no database, is identical for
 * `sqliteApiKeyStore` and `memoryApiKeyDirectory` — which the tests treat as
 * interchangeable — and can be exercised against row shapes a real store would
 * refuse to create, which is exactly the case that matters here: the pre-column
 * row with no contact at all. It is also reached only from `keysCli.ts`, so it
 * adds no edge to the serving import graph `publicAppGraph.test.ts` pins.
 *
 * ## The one property that must not be lost
 *
 * **A key with no contact is reported, not skipped.** The tempting shape is a
 * `string[]` of addresses, which quietly drops every contactless key and hands
 * the sender a list that looks complete. Then a model changes, the notice goes
 * out to everyone on the list, and the subscribers we could not reach are
 * invisible — the failure is silent at exactly the moment §9.3 is being relied
 * on. So {@link ContactSet} has two halves and a caller has to look at both;
 * `keysCli.ts` prints the second even when it is empty, because "every live key
 * has a contact" is a finding and a blank space is not.
 *
 * ABL-529 owns sending. Nothing here sends anything.
 */

/** One address, and every live key that names it. */
export interface ContactRecipient {
  /** As stored — the spelling the operator gave. See {@link collectAccountContacts}. */
  email: string;
  /** Accounts reachable at this address, ascending. One address may serve several. */
  accountIds: string[];
  /** Live keys whose contact this is, in the order they were given. */
  keyIds: string[];
}

/** A live key we have promised to notify and have no way to reach. */
export interface UnreachableKey {
  keyId: string;
  accountId: string;
  label: string;
  /**
   * Why it cannot be reached.
   *
   * One member today, and a union rather than a bare marker because the next
   * cause is foreseeable — an address that hard-bounces is *known* undeliverable
   * rather than absent, and the two want different fixes. A union makes adding
   * that a widening; a boolean would make it a rewrite.
   */
  reason: 'no_contact_recorded';
}

export interface ContactSet {
  /** Deduplicated, ordered by address. */
  recipients: ContactRecipient[];
  /** Live keys with no address at all. Empty is a result, not an absence. */
  unreachable: UnreachableKey[];
  /** How many live keys were considered, so a caller can state the denominator. */
  liveKeys: number;
}

/**
 * Compare two addresses the way a mail system would, for deduplication only.
 *
 * Lowercased, so `Ops@Acme.example` and `ops@acme.example` are one recipient
 * rather than two identical lines in a notice. This is *not* applied to what is
 * stored — `requireContactEmail` keeps the operator's spelling, because the
 * local part is case-sensitive by specification and rewriting it could change
 * where a notice lands. Getting the comparison wrong costs a duplicate line;
 * getting the storage wrong costs a delivery.
 */
function dedupeKeyFor(email: string): string {
  return email.toLowerCase();
}

/**
 * The recipient list, from the key store's records.
 *
 * **Scoped to live keys**, `now`-injected so the boundary is testable without
 * waiting. A revoked or expired key is a credential that has stopped working,
 * and its holder is not a subscriber §9.3 owes a notice to; including them would
 * mail every customer we have ever had about every model change. An account
 * whose keys have all lapsed therefore drops off the list, which is correct and
 * is also why {@link ContactSet.liveKeys} is returned — a caller reporting "0
 * recipients" should be able to say whether that is because nobody has a
 * contact or because nobody has a key.
 */
export function collectAccountContacts(keys: ApiKeyRecord[], now: Date): ContactSet {
  const byAddress = new Map<string, ContactRecipient>();
  const unreachable: UnreachableKey[] = [];
  let liveKeys = 0;

  for (const key of keys) {
    if (!isKeyLive(key, now)) continue;
    liveKeys += 1;

    // `?? ''` and the trim together: a column that is NULL and one holding
    // whitespace are the same claim about reachability, and only one of them is
    // reachable through the write path. The other arrives from a hand-edited
    // file, which is exactly when a silent pass would hurt.
    const email = (key.contactEmail ?? '').trim();
    if (email === '') {
      unreachable.push({
        keyId: key.id,
        accountId: key.accountId,
        label: key.label,
        reason: 'no_contact_recorded',
      });
      continue;
    }

    const dedupeKey = dedupeKeyFor(email);
    const existing = byAddress.get(dedupeKey);
    if (existing) {
      existing.keyIds.push(key.id);
      if (!existing.accountIds.includes(key.accountId)) existing.accountIds.push(key.accountId);
    } else {
      byAddress.set(dedupeKey, { email, accountIds: [key.accountId], keyIds: [key.id] });
    }
  }

  const recipients = [...byAddress.values()].sort((a, b) =>
    dedupeKeyFor(a.email) < dedupeKeyFor(b.email) ? -1 : 1
  );
  for (const recipient of recipients) recipient.accountIds.sort();

  return { recipients, unreachable, liveKeys };
}
