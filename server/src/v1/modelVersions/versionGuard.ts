import {
  MATERIAL_NOTICE_DAYS,
  type AcknowledgedPair,
  type AcknowledgementLedger,
} from './acknowledgements.js';

/**
 * The rule, as pure functions. No database, no clock of its own, no I/O.
 *
 * `scripts/backfillModelGuard.ts` is the house precedent this follows: a guard
 * that refuses and explains why, split out so the refusal itself can be tested
 * rather than inferred from an endpoint's behaviour.
 *
 * ## Refused, not reported — and the fallback is the load-bearing half
 *
 * ABL-529 asks for three things, and the third is the one with a trap in it:
 * *"A change in (1) that is not in (2) is refused, not reported"*, and *"it must
 * not blank a series"*. Those pull in opposite directions, and the shape that
 * satisfies both is a **filter, not a rejection**: the serving queries restrict
 * `model_version` to the acknowledged set, so an unacknowledged artifact is
 * invisible while the previously acknowledged one keeps answering. The
 * subscriber gets stale-but-honest numbers, which the response already labels —
 * `latest_vintage_at` and `freshness.status` are computed from the *filtered*
 * rows, so a frozen series reports itself as frozen rather than borrowing the
 * withheld run's timestamp.
 *
 * That is why `createVersionGate` returns a set of versions rather than a
 * boolean. A boolean can only refuse the request; a set can withhold one
 * artifact and keep serving another.
 *
 * ## Why absence means "serve everything"
 *
 * §9.3.1: *"beginning to serve a combination we did not serve before is not"*
 * material. A triple absent from the ledger has never been served, so nothing a
 * subscriber relied on can move by our serving it, and `servableVersions`
 * returns `null` — "no restriction". Fail-open **for new triples only** is the
 * contract, not a concession: fail-closed there would make the guard block
 * ABL-525's eight additive pairs, which §9.1 says may ship at any time.
 *
 * Once a triple is in the ledger the polarity inverts and it is fail-closed: an
 * unrecognised version is withheld. A `model_version` of `null` — which no row
 * in the public slice carries today, measured across 2,246,927 rows — is
 * therefore withheld too, and reported by `npm run modelversions -- status`
 * rather than passed through unnoticed.
 *
 * ## What this guard cannot do, stated rather than implied
 *
 * §9.3.1's M4 also makes it material to *stop* covering a zone a model covered.
 * A guard on the read path cannot refuse a disappearance — there are no rows to
 * withhold — so `diffLedger` reports it as `withdrawn` and nothing enforces it.
 * That asymmetry is real and is why the diff is part of this mechanism rather
 * than an afterthought.
 */

/** `zone|forecast_type|model`. Internal; never on the wire. */
export type TripleKey = string;

export function tripleKey(zone: string, forecastType: string, model: string): TripleKey {
  return `${zone}|${forecastType}|${model}`;
}

/**
 * What the serving queries are handed: one question, asked per (zone, type, model).
 *
 * Deliberately not the ledger itself. The repo should not have to know about
 * `serve_from`, a clock, or the A1 exemption — it needs a `WHERE` clause, and
 * resolving the rule once per request keeps the SQL builders free of policy.
 */
export interface VersionGate {
  /**
   * The `model_version` values that may reach a subscriber for this triple.
   *
   * `null` means *no restriction* — the triple is absent from the ledger and is
   * therefore additive under §9.1. An empty array means the triple is known and
   * nothing is servable yet, which is a real state (every acknowledgement for it
   * is still inside its notice period) and renders as an empty page.
   */
  servableVersions(zone: string, forecastType: string, model: string): readonly string[] | null;
}

/**
 * Resolve the ledger against a clock.
 *
 * Built **per request** rather than once at startup, and that is not a
 * micro-decision: a material acknowledgement becomes servable at its
 * `serve_from` instant, and a gate frozen at boot would keep withholding the new
 * artifact until somebody restarted the process. The thirtieth day has to arrive
 * on its own.
 *
 * Cost is a walk of the ledger's records, which is one entry today and grows by
 * one per promotion. If that ever stops being free, memoize on
 * `(ledger, minute)` — not on `(ledger)`.
 */
export function createVersionGate(ledger: AcknowledgementLedger, now: Date): VersionGate {
  const servable = new Map<TripleKey, string[]>();
  const known = new Set<TripleKey>();
  const at = now.getTime();

  for (const record of ledger) {
    const live = Date.parse(record.serve_from) <= at;
    for (const pair of record.pairs) {
      const key = tripleKey(pair.zone, pair.forecast_type, pair.model);
      // A triple is "known" the moment it appears anywhere in the ledger, even
      // under an acknowledgement that has not matured. Otherwise recording a
      // future-dated material change would make the triple look brand new, the
      // A1 exemption would apply, and the guard would serve the very artifact
      // the acknowledgement exists to hold back for 30 days.
      known.add(key);
      if (!live) continue;
      const versions = servable.get(key);
      if (versions === undefined) servable.set(key, [pair.model_version]);
      else if (!versions.includes(pair.model_version)) versions.push(pair.model_version);
    }
  }

  return {
    servableVersions(zone, forecastType, model) {
      const key = tripleKey(zone, forecastType, model);
      if (!known.has(key)) return null;
      return servable.get(key) ?? [];
    },
  };
}

/** A gate that restricts nothing. For fixtures and for the private surface, which §9.3 does not bind. */
export const OPEN_VERSION_GATE: VersionGate = {
  servableVersions: () => null,
};

/**
 * What one observed `(triple, version)` is, relative to the ledger.
 *
 * - `additive` — the triple is not in the ledger at all. §9.1/A1: ships freely.
 * - `servable` — acknowledged, and its notice period has elapsed.
 * - `embargoed` — acknowledged, still inside its 30 days. Withheld *on purpose*,
 *   and the distinction from `unacknowledged` is the whole point: one is the
 *   mechanism working, the other is a change nobody has signed.
 * - `unacknowledged` — the triple is served and this artifact is not signed.
 *   **This is the §9.3.1 M1 breach**, caught before the numbers ship.
 */
export type VersionVerdict = 'additive' | 'servable' | 'embargoed' | 'unacknowledged';

/** One `(zone, forecast_type, model)` triple and the artifact the database would serve for it. */
export interface ObservedVersion {
  zone: string;
  forecast_type: string;
  model: string;
  /** `null` where the row carries no `model_version`. Reported, never treated as a wildcard. */
  model_version: string | null;
  /** The `generated_at` of the run this version came from, in stored form. */
  newest_vintage_at: string | null;
}

export function classifyVersion(
  ledger: AcknowledgementLedger,
  observed: ObservedVersion,
  now: Date
): VersionVerdict {
  const key = tripleKey(observed.zone, observed.forecast_type, observed.model);
  const at = now.getTime();
  let known = false;

  for (const record of ledger) {
    for (const pair of record.pairs) {
      if (tripleKey(pair.zone, pair.forecast_type, pair.model) !== key) continue;
      known = true;
      if (pair.model_version !== observed.model_version) continue;
      return Date.parse(record.serve_from) <= at ? 'servable' : 'embargoed';
    }
  }

  return known ? 'unacknowledged' : 'additive';
}

/** A triple the ledger signs off but the database no longer produces. */
export interface WithdrawnPair extends AcknowledgedPair {
  /** True when the whole triple has gone, not merely this artifact. §9.3.1 M4. */
  triple_gone: boolean;
}

export interface LedgerDiff {
  /** Signed and live. Nothing to do. */
  servable: ObservedVersion[];
  /** New triples we have never served. Additive under §9.1 — ship freely, no clock. */
  additive: ObservedVersion[];
  /** Signed, inside its notice period, withheld on purpose. The mechanism working. */
  embargoed: ObservedVersion[];
  /**
   * Served triples running an artifact nobody signed. **The §9.3 breach the guard
   * withholds.** Non-empty here means a 30-day clock needs to start.
   */
  unacknowledged: ObservedVersion[];
  /**
   * Acknowledged pairs the database no longer produces.
   *
   * Two causes, and they need different responses, so `triple_gone` separates
   * them. A superseded version is ordinary and expected — the old artifact
   * stopped writing when the new one took over, and its entry is retained
   * deliberately. A whole triple vanishing is §9.3.1 **M4**, a material change
   * this guard can report and cannot prevent.
   */
  withdrawn: WithdrawnPair[];
}

/**
 * Compare what the database would serve against what a human has signed.
 *
 * The input is the *unfiltered* truth — what the rows say, not what the gate
 * currently allows out. A detector that only looked at what it already permits
 * could never see the change it exists to catch.
 */
export function diffLedger(
  observed: readonly ObservedVersion[],
  ledger: AcknowledgementLedger,
  now: Date
): LedgerDiff {
  const diff: LedgerDiff = {
    servable: [],
    additive: [],
    embargoed: [],
    unacknowledged: [],
    withdrawn: [],
  };

  for (const row of observed) {
    diff[classifyVersion(ledger, row, now)].push(row);
  }

  const seenVersions = new Set(
    observed.map((row) => `${tripleKey(row.zone, row.forecast_type, row.model)}|${row.model_version}`)
  );
  const seenTriples = new Set(observed.map((row) => tripleKey(row.zone, row.forecast_type, row.model)));
  const reported = new Set<string>();

  for (const record of ledger) {
    for (const pair of record.pairs) {
      const key = tripleKey(pair.zone, pair.forecast_type, pair.model);
      const versionKey = `${key}|${pair.model_version}`;
      if (seenVersions.has(versionKey) || reported.has(versionKey)) continue;
      reported.add(versionKey);
      diff.withdrawn.push({ ...pair, triple_gone: !seenTriples.has(key) });
    }
  }

  return diff;
}

/**
 * Refuse a malformed ledger, loudly, with the reason.
 *
 * Every check here is something a hurried edit does, and every one of them fails
 * *silently* at runtime if it is not checked: a duplicate `id` makes a changelog
 * entry ambiguous about which record it describes; a `material` record without
 * its 30 days serves a change the same afternoon it was signed, which is the
 * breach the file exists to prevent, with the file's own blessing; an
 * unparseable instant makes `Date.parse` return `NaN`, and `NaN <= at` is
 * `false`, so the record silently never becomes servable and the pair blanks on
 * the day it was supposed to cut over.
 *
 * Called from `versionGuard.test.ts` against the real ledger, so a bad entry
 * fails the suite rather than a subscriber's request.
 */
export function assertLedgerWellFormed(ledger: AcknowledgementLedger): void {
  const ids = new Set<string>();
  const noticeMs = MATERIAL_NOTICE_DAYS * 24 * 60 * 60 * 1000;

  for (const record of ledger) {
    if (ids.has(record.id)) {
      throw new Error(`Duplicate acknowledgement id '${record.id}'. Ids are quoted in changelog entries.`);
    }
    ids.add(record.id);

    const signed = Date.parse(record.acknowledged_at);
    const from = Date.parse(record.serve_from);
    if (Number.isNaN(signed)) {
      throw new Error(`'${record.id}': acknowledged_at '${record.acknowledged_at}' is not an instant.`);
    }
    if (Number.isNaN(from)) {
      throw new Error(
        `'${record.id}': serve_from '${record.serve_from}' is not an instant. An unparseable ` +
          `serve_from never matures, so the pairs would blank instead of cutting over.`
      );
    }
    if (from < signed) {
      throw new Error(`'${record.id}': serve_from precedes acknowledged_at.`);
    }
    if (record.kind === 'material' && from - signed < noticeMs) {
      throw new Error(
        `'${record.id}': a material change must serve no earlier than ${MATERIAL_NOTICE_DAYS} days ` +
          `after it is acknowledged (ToS §9.3). serve_from is ${Math.round((from - signed) / 86_400_000)} ` +
          `days after acknowledged_at. If this is a fix for values that are wrong, it is a ` +
          `correction under §9.3.2 — set kind: 'correction' and say what was wrong in the note, ` +
          `which is what the changelog entry has to state.`
      );
    }
    if (record.pairs.length === 0) {
      throw new Error(`'${record.id}': acknowledges no pairs. A record that names nothing records nothing.`);
    }
    if (record.note.trim() === '') {
      throw new Error(`'${record.id}': empty note. The note is what the changelog entry is written from.`);
    }
    if (record.acknowledged_by.trim() === '') {
      throw new Error(`'${record.id}': empty acknowledged_by. A human signs this, not a script.`);
    }

    const pairKeys = new Set<string>();
    for (const pair of record.pairs) {
      const key = `${tripleKey(pair.zone, pair.forecast_type, pair.model)}|${pair.model_version}`;
      if (pairKeys.has(key)) throw new Error(`'${record.id}': duplicate pair ${key}.`);
      pairKeys.add(key);
      if (pair.model_version.trim() === '') {
        throw new Error(
          `'${record.id}': empty model_version for ${pair.zone}/${pair.forecast_type}/${pair.model}. ` +
            `An empty version matches no row and would blank the pair.`
        );
      }
    }
  }
}
