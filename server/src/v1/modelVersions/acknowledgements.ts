/**
 * The versions a human has signed off, and nothing that reads a database.
 *
 * This file is the **acknowledged set** — the checked-in half of ToS §9.3's
 * trigger (ABL-529). Its counterpart is `servedLedger.ts`, which measures what
 * the database would actually serve; `versionGuard.ts` is the rule that decides
 * what a disagreement between the two means.
 *
 * ## What §9.3.1 actually obliges, in one paragraph
 *
 * The Terms (Draft 0.5, Board-confirmed 2026-08-22) say a model change is
 * material *"if a request you made yesterday, repeated unchanged today, would
 * return **different forecast values under the same `model` label**"*, and that
 * material changes get **30 days' advance notice**. The `/v1` surface labels a
 * model by **family** — `PUBLIC_FORECAST_MODELS = ['catboost', 'xgboost']` —
 * while the artifact identity lives in `forecasts.model_version`, which appears
 * on no response. So retraining the artifact behind a pair we already serve
 * moves every number under an unchanged label: §9.3.1's M1, the silent case.
 *
 * §9.3.1 also draws the other side of the line, and it is the reason this guard
 * is not a blocker on ordinary work: *"beginning to serve a combination we did
 * not serve before **is not**"* material — additive under §9.1, may ship at any
 * time. That is ruling A1, and **ABL-525's eight new pairs are exactly it**.
 *
 * ## The rule this file's shape encodes
 *
 * A triple `(zone, forecast_type, model)` that appears **nowhere** in the ledger
 * is a triple we have never served, so it is additive and serves unfiltered. A
 * triple that appears **at all** is one we already serve, so from then on only
 * the versions recorded here may reach a subscriber. Absence is therefore not a
 * hole in the ledger — it is the A1 exemption, expressed as data rather than as
 * a flag somebody has to set correctly.
 *
 * The consequence is worth stating because it is the whole ergonomic argument:
 * the guard costs nothing until the first retrain of an existing pair, which is
 * the one event §9.3 puts a clock on.
 *
 * ## Why entries accumulate and are never deleted
 *
 * A material change is served by *adding* the new version, not by replacing the
 * old one. During the 30 days the old entry is what keeps the series alive — the
 * fallback ABL-529 requires, so a subscriber gets stale-but-honest numbers
 * rather than an empty page — and on the thirtieth day both versions are
 * servable, at which point `MAX(generated_at)` picks the newer rows and the
 * cutover happens with no deploy. Deleting the superseded entry would blank the
 * pair for as long as the old artifact was still the newest thing we were
 * allowed to serve.
 *
 * So this file only ever grows, and that is the audit trail: every version that
 * ever reached a subscriber, with the date a human signed it and why.
 */

/** One `(zone, forecast_type, model)` triple and the artifact signed off for it. */
export interface AcknowledgedPair {
  /** `forecasts.country_code`. */
  zone: string;
  /** `forecasts.forecast_type`, one of `PUBLIC_FORECAST_TYPE_IDS`. */
  forecast_type: string;
  /** `forecasts.model_name`, one of `PUBLIC_FORECAST_MODELS`. */
  model: string;
  /** `forecasts.model_version` — the artifact identity, verbatim. */
  model_version: string;
}

/**
 * Why a set of versions may be served, and under which clause.
 *
 * Three kinds rather than two, because "how did this become servable" is a
 * question the changelog has to answer and a boolean cannot:
 *
 * - `material` — §9.3. A planned change. `serve_from` is at least 30 days after
 *   `acknowledged_at`, and `assertLedgerWellFormed` refuses the record if it is
 *   not, so the clause is enforced by the file rather than by whoever writes it.
 * - `correction` — §9.3.2. A fix for values that are *wrong*. Exempt from the 30
 *   days and may serve immediately; **not** exempt from the changelog, which
 *   must go up at the moment the fix is served, saying it was a correction and
 *   what was wrong. Without this kind the guard would block the one change §9.3
 *   explicitly permits us to ship at once — the live case being the NL
 *   gross-basis load forecast (ABL-501 / ABL-505 / ABL-506).
 * - `baseline` — neither. The state measured when this ledger was first built,
 *   never reviewed for materiality by anyone. See `BASELINE_2026_08_22`.
 */
export type AcknowledgementKind = 'baseline' | 'material' | 'correction';

/**
 * One signed-off record, naming every pair it covers.
 *
 * The record — not the individual pair — is the unit, because ABL-529's "done
 * when" asks the acknowledgement to *"leave a record that names the pairs
 * affected"* and for that record to be *"what the changelog entry is written
 * from"*. A per-pair row would make one promotion into 21 disconnected
 * assertions with no shared reason; this shape is one reason and its blast
 * radius, which is the shape a changelog entry has.
 */
export interface VersionAcknowledgement {
  /** Stable, quotable in a changelog entry. Kebab-case; unique across the ledger. */
  id: string;
  kind: AcknowledgementKind;
  /** When a human signed this. ISO-8601 UTC, second precision. */
  acknowledged_at: string;
  /** Who. A role, not a machine — `npm run modelversions` cannot fill this in. */
  acknowledged_by: string;
  /**
   * The first instant any version in this record may reach a subscriber.
   *
   * For `material`, `acknowledged_at + 30 days` at the earliest — this is the
   * §9.3 clock, enforced rather than remembered. For `correction` and
   * `baseline` it may equal `acknowledged_at`.
   *
   * Evaluated per request against the injected clock, so a process running
   * across the thirtieth day starts serving the new artifact without a restart.
   */
  serve_from: string;
  /** What changed and why — the text the changelog entry is written from. */
  note: string;
  pairs: readonly AcknowledgedPair[];
}

export type AcknowledgementLedger = readonly VersionAcknowledgement[];

/** The §9.3 notice period, in days. The one number this whole mechanism exists to enforce. */
export const MATERIAL_NOTICE_DAYS = 30;

/**
 * The state measured on 2026-08-22, signed as a baseline rather than as a review.
 *
 * **This record is the one honest thing that can be said about it, and it says
 * the uncomfortable part.** ABL-526 warned that building the ledger after a
 * promotion means *"seeding 'already acknowledged' from whatever happens to be
 * live, with no record of how it got there — a guard that starts by trusting an
 * unaudited state"*. There is no way to avoid seeding: refusing all 74 triples
 * would blank the entire `/v1` forecast surface, which is worse than the problem
 * the guard solves. What *is* avoidable is the silence, so:
 *
 * - **Nobody reviewed these 74 artifacts for materiality.** They are what the
 *   database held. `kind` is `baseline` precisely so a future reader cannot
 *   mistake this for a signed material change.
 * - **Nothing was published under them.** No external API key exists and ABL-349
 *   forbids issuing one, so §9.3's clock is not running and no subscriber has
 *   ever received a number from any of these versions. The seed grandfathers no
 *   breach because there is no subscriber to have breached against.
 * - **It was measured, not assumed.** Read-only against the workstation replica
 *   `C:/Code/able/data/energy_dashboard.db` on 2026-08-22, over the eight
 *   `PUBLIC_FORECAST_TYPES` and the two `PUBLIC_FORECAST_MODELS`: 2,246,927 rows,
 *   74 triples, **0 rows with a NULL or empty `model_version`**, and **exactly
 *   one `model_version` per triple at its newest vintage** — so "the version
 *   currently served" was a well-defined single value everywhere, not a choice.
 *   `npm run modelversions -- status` re-runs that measurement against whatever
 *   database it is pointed at and reports every disagreement with this list.
 * - **Retrains have already happened, before anyone was watching.** 13 of the 74
 *   triples hold more than one `model_version` across full history — FR `load`
 *   xgboost went `20251224_172741` → `20260201_221331`, DE `price` xgboost
 *   `20260112_093054` → `20260202_135018`. Under §9.3.1 each of those is an M1
 *   material change that happened with no notice and no record. They are the
 *   evidence that this is a real failure mode rather than a hypothetical one,
 *   and the superseded versions are deliberately **not** listed below: the
 *   ledger records what may be served now, and those artifacts stopped producing
 *   rows at the swap.
 *
 * The next record added to this file will be a real one.
 */
const BASELINE_2026_08_22: VersionAcknowledgement = {
  id: 'baseline-2026-08-22',
  kind: 'baseline',
  acknowledged_at: '2026-08-22T00:00:00Z',
  acknowledged_by: 'API Platform Engineer (ABL-529), recorded as measured — not reviewed for materiality',
  serve_from: '2026-08-22T00:00:00Z',
  note:
    'Seed. The 74 (zone, forecast_type, model) triples the /v1 forecast surface was serving when ' +
    'the served-version ledger was built, measured read-only against the replica on 2026-08-22. ' +
    'Not a material change and not a review: nothing has been published under these versions, ' +
    'because no external API key exists (ABL-349). Recorded so that every later change is a diff ' +
    'against a stated starting point rather than against an unexamined one.',
  pairs: [
    { zone: 'AT', forecast_type: 'load', model: 'xgboost', model_version: '20260201_221635' },
    { zone: 'AT', forecast_type: 'price', model: 'catboost', model_version: '20260202_144224' },
    { zone: 'AT', forecast_type: 'price', model: 'xgboost', model_version: '20260112_165237' },
    { zone: 'AT', forecast_type: 'renewable', model: 'xgboost', model_version: '20260112_165237' },
    { zone: 'AT', forecast_type: 'solar', model: 'xgboost', model_version: '20260112_165237' },
    { zone: 'AT', forecast_type: 'wind_onshore', model: 'xgboost', model_version: '20260112_165238' },
    { zone: 'BE', forecast_type: 'biomass', model: 'xgboost', model_version: '20251226_155417' },
    { zone: 'BE', forecast_type: 'hydro_total', model: 'xgboost', model_version: '20251226_155416' },
    { zone: 'BE', forecast_type: 'load', model: 'xgboost', model_version: '20251229_061652' },
    { zone: 'BE', forecast_type: 'price', model: 'xgboost', model_version: '20260201_223138' },
    { zone: 'BE', forecast_type: 'renewable', model: 'catboost', model_version: '20260201_222006' },
    { zone: 'BE', forecast_type: 'renewable', model: 'xgboost', model_version: '20251226_155411' },
    { zone: 'BE', forecast_type: 'solar', model: 'catboost', model_version: '20260201_222022' },
    { zone: 'BE', forecast_type: 'solar', model: 'xgboost', model_version: '20251226_155412' },
    { zone: 'BE', forecast_type: 'wind_offshore', model: 'xgboost', model_version: '20251226_155415' },
    { zone: 'BE', forecast_type: 'wind_onshore', model: 'catboost', model_version: '20260201_222020' },
    { zone: 'BE', forecast_type: 'wind_onshore', model: 'xgboost', model_version: '20251226_155413' },
    { zone: 'BG', forecast_type: 'load', model: 'catboost', model_version: '20260202_154722' },
    { zone: 'BG', forecast_type: 'price', model: 'catboost', model_version: '20260202_154820' },
    { zone: 'CH', forecast_type: 'load', model: 'catboost', model_version: '20260202_154724' },
    { zone: 'CH', forecast_type: 'price', model: 'catboost', model_version: '20260202_154823' },
    { zone: 'CZ', forecast_type: 'load', model: 'catboost', model_version: '20260202_154727' },
    { zone: 'CZ', forecast_type: 'price', model: 'catboost', model_version: '20260202_154826' },
    { zone: 'DE', forecast_type: 'load', model: 'catboost', model_version: '20260105_210648' },
    { zone: 'DE', forecast_type: 'price', model: 'xgboost', model_version: '20260202_135018' },
    { zone: 'DE', forecast_type: 'renewable', model: 'catboost', model_version: '20260201_221953' },
    { zone: 'DE', forecast_type: 'solar', model: 'catboost', model_version: '20260223_193822' },
    { zone: 'DE', forecast_type: 'wind_onshore', model: 'catboost', model_version: '20260201_222000' },
    { zone: 'DE', forecast_type: 'wind_onshore', model: 'xgboost', model_version: '20251226_132944' },
    { zone: 'EE', forecast_type: 'load', model: 'catboost', model_version: '20260202_154730' },
    { zone: 'EE', forecast_type: 'price', model: 'catboost', model_version: '20260202_154829' },
    { zone: 'ES', forecast_type: 'load', model: 'catboost', model_version: '20260201_223233' },
    { zone: 'ES', forecast_type: 'price', model: 'xgboost', model_version: '20260202_141043' },
    { zone: 'FI', forecast_type: 'load', model: 'catboost', model_version: '20260202_154734' },
    { zone: 'FI', forecast_type: 'price', model: 'catboost', model_version: '20260202_154831' },
    { zone: 'FR', forecast_type: 'biomass', model: 'xgboost', model_version: '20251226_134331' },
    { zone: 'FR', forecast_type: 'hydro_total', model: 'xgboost', model_version: '20251226_134329' },
    { zone: 'FR', forecast_type: 'load', model: 'xgboost', model_version: '20260201_221331' },
    { zone: 'FR', forecast_type: 'price', model: 'xgboost', model_version: '20260201_222541' },
    { zone: 'FR', forecast_type: 'renewable', model: 'catboost', model_version: '20260201_222000' },
    { zone: 'FR', forecast_type: 'renewable', model: 'xgboost', model_version: '20251224_173855' },
    { zone: 'FR', forecast_type: 'solar', model: 'catboost', model_version: '20260201_222014' },
    { zone: 'FR', forecast_type: 'solar', model: 'xgboost', model_version: '20251226_153136' },
    { zone: 'FR', forecast_type: 'wind_offshore', model: 'xgboost', model_version: '20251226_134328' },
    { zone: 'FR', forecast_type: 'wind_onshore', model: 'catboost', model_version: '20260201_222010' },
    { zone: 'FR', forecast_type: 'wind_onshore', model: 'xgboost', model_version: '20251226_134326' },
    { zone: 'GR', forecast_type: 'load', model: 'catboost', model_version: '20260202_154736' },
    { zone: 'GR', forecast_type: 'price', model: 'catboost', model_version: '20260202_154834' },
    { zone: 'HR', forecast_type: 'load', model: 'catboost', model_version: '20260202_154740' },
    { zone: 'HR', forecast_type: 'price', model: 'catboost', model_version: '20260202_154835' },
    { zone: 'HU', forecast_type: 'load', model: 'catboost', model_version: '20260202_154743' },
    { zone: 'HU', forecast_type: 'price', model: 'catboost', model_version: '20260202_154838' },
    { zone: 'IT', forecast_type: 'load', model: 'catboost', model_version: '20260201_223239' },
    { zone: 'IT', forecast_type: 'price', model: 'catboost', model_version: '20260201_223239' },
    { zone: 'LT', forecast_type: 'load', model: 'catboost', model_version: '20260202_154746' },
    { zone: 'LT', forecast_type: 'price', model: 'catboost', model_version: '20260202_154841' },
    { zone: 'LV', forecast_type: 'load', model: 'catboost', model_version: '20260202_154748' },
    { zone: 'LV', forecast_type: 'price', model: 'catboost', model_version: '20260202_154843' },
    { zone: 'NL', forecast_type: 'load', model: 'catboost', model_version: '20260201_223246' },
    { zone: 'NL', forecast_type: 'price', model: 'catboost', model_version: '20260201_223245' },
    { zone: 'NO', forecast_type: 'load', model: 'catboost', model_version: '20260202_154752' },
    { zone: 'NO', forecast_type: 'price', model: 'catboost', model_version: '20260202_154846' },
    { zone: 'PL', forecast_type: 'load', model: 'catboost', model_version: '20260201_223253' },
    { zone: 'PL', forecast_type: 'price', model: 'catboost', model_version: '20260201_223249' },
    { zone: 'PT', forecast_type: 'load', model: 'catboost', model_version: '20260201_223258' },
    { zone: 'PT', forecast_type: 'price', model: 'xgboost', model_version: '20260202_140646' },
    { zone: 'RO', forecast_type: 'load', model: 'catboost', model_version: '20260202_154756' },
    { zone: 'RO', forecast_type: 'price', model: 'catboost', model_version: '20260202_154848' },
    { zone: 'SE', forecast_type: 'load', model: 'catboost', model_version: '20260202_154757' },
    { zone: 'SE', forecast_type: 'price', model: 'catboost', model_version: '20260202_154851' },
    { zone: 'SI', forecast_type: 'load', model: 'catboost', model_version: '20260202_154800' },
    { zone: 'SI', forecast_type: 'price', model: 'catboost', model_version: '20260202_154853' },
    { zone: 'SK', forecast_type: 'load', model: 'catboost', model_version: '20260202_154803' },
    { zone: 'SK', forecast_type: 'price', model: 'catboost', model_version: '20260202_154855' },
  ],
};

/**
 * The ledger the serving process uses.
 *
 * Append records; never edit or remove one. `publicIndex.ts` is the only place
 * that hands this to a running server, and `versionGuard.test.ts` asserts the
 * whole file is well-formed — including that every `material` record really does
 * carry its 30 days, which is the one property a hurried edit would drop.
 */
export const ACKNOWLEDGED_VERSIONS: AcknowledgementLedger = [BASELINE_2026_08_22];
