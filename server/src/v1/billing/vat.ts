import { roundHalfUpDiv, type Money, money } from './money.js';

/**
 * EU VAT for a subscription API: where the supply happens, who accounts for the
 * tax, and at what rate.
 *
 * The service being sold is an **electronically supplied service** — an
 * automated, digitally-delivered data feed with no human intervention — which is
 * the category that decides everything below. For those, the place of supply is
 * where the *customer* belongs, not where we do, and that single rule produces
 * the four outcomes in {@link VatTreatmentKind}.
 *
 * ## The decision this module makes conservatively, on purpose
 *
 * Cross-border B2B inside the EU is zero-rated under the reverse charge, and the
 * customer accounts for the VAT themselves. That relief is conditional on the
 * customer's VAT identification number being **valid**, and validity is a fact
 * about the VIES database rather than about the string: a well-formed number
 * that VIES does not confirm leaves the supplier liable for the VAT it did not
 * charge.
 *
 * VIES is an external network service. This deployment is LAN-only and makes no
 * outbound calls, so **no VAT number here has been validated**, and
 * {@link resolveVatTreatment} therefore refuses to apply the reverse charge on a
 * number whose validation was not recorded. Such a customer is taxed as a
 * consumer instead. That over-charges rather than under-charges, which is the
 * wrong direction for this codebase's usual rule and the right one here: an
 * over-charge is refundable to the customer, whereas an unclaimable reverse
 * charge is a liability to a tax authority plus a penalty, and it is discovered
 * at audit rather than by the customer. {@link VatTreatment.notes} says so on
 * the invoice, so nobody has to infer it. `provider.ts` records what a real VIES
 * check would have to write down for the relief to be applied.
 *
 * ## What is reference data here, and what still needs counsel
 *
 * {@link EU_VAT_STANDARD_RATES} is statutory public data rather than a
 * commercial decision, so it is in source rather than in the price book — but it
 * is dated, marked unverified, and carried onto every invoice
 * ({@link VatRatesProvenance}). ABL-349 keeps subscriber terms unpublished and
 * this module does not change that: nothing here may produce a legally issued
 * invoice until counsel has signed off the rate table, the registration status,
 * and the invoice legends quoted below.
 *
 * Reduced rates are deliberately absent. Every member state applies its standard
 * rate to electronically supplied data services of this kind; a reduced-rate
 * table would be six columns of exceptions that do not apply to us, and the
 * first one that did would be a decision, not a lookup.
 */

/**
 * When {@link EU_VAT_STANDARD_RATES} was last transcribed, and the fact that
 * nobody qualified has checked it.
 *
 * Carried onto every invoice. A rate table with no date is one nobody can audit:
 * rates move on statutory schedules, an invoice is defended years later, and
 * "the rate we used in August 2026" has to be answerable without a `git blame`.
 */
export const VAT_RATES_AS_OF = '2026-01-01';

export interface VatRatesProvenance {
  asOf: string;
  /**
   * `false`, and it stays `false` until counsel signs the table off.
   *
   * Rendered on the invoice document. A draft that silently claimed verified
   * rates would be indistinguishable from a real one at exactly the moment
   * somebody was deciding whether to send it.
   */
  verified: boolean;
}

export const VAT_RATES_PROVENANCE: VatRatesProvenance = Object.freeze({
  asOf: VAT_RATES_AS_OF,
  verified: false,
});

/**
 * Standard VAT rates in **basis points**, so the arithmetic stays in integers.
 *
 * Finland's 25.5% is why this is not a percentage integer: a table of whole
 * percents would have to round a real statutory rate, on every Finnish invoice,
 * in a module whose entire premise is that money is exact.
 *
 * The 27 member states as of {@link VAT_RATES_AS_OF}. A country absent from this
 * table is treated as non-EU by {@link isEuMemberState}, which is the safe
 * direction for a typo — `outside_scope` produces a zero-rated invoice with a
 * legend a human will question, whereas a silent default rate produces a
 * confident wrong number.
 */
export const EU_VAT_STANDARD_RATES: Readonly<Record<string, number>> = Object.freeze({
  AT: 2000,
  BE: 2100,
  BG: 2000,
  CY: 1900,
  CZ: 2100,
  DE: 1900,
  DK: 2500,
  EE: 2400,
  ES: 2100,
  FI: 2550,
  FR: 2000,
  GR: 2400,
  HR: 2500,
  HU: 2700,
  IE: 2300,
  IT: 2200,
  LT: 2100,
  LU: 1700,
  LV: 2100,
  MT: 1800,
  NL: 2100,
  PL: 2300,
  PT: 2300,
  RO: 2100,
  SE: 2500,
  SI: 2200,
  SK: 2300,
});

export const BASIS_POINTS_PER_UNIT = 10_000;

export function isEuMemberState(country: string): boolean {
  return Object.hasOwn(EU_VAT_STANDARD_RATES, country.toUpperCase());
}

/**
 * Structural patterns for a VAT identification number, by country.
 *
 * A **format** check and nothing more. It catches a transposed digit or a number
 * pasted with its country prefix twice; it says nothing about whether the number
 * belongs to anyone. That distinction is the whole of this module's caution
 * about the reverse charge, so the function that applies it is named
 * {@link vatIdLooksWellFormed} rather than `isValidVatId` — a name that would
 * invite exactly the conflation the relief turns on.
 *
 * Greece is the one to know about: its VAT prefix is `EL`, not its ISO country
 * code `GR`. A pattern table keyed on the ISO code with `GR` here would reject
 * every Greek business.
 */
const VAT_ID_PATTERNS: Readonly<Record<string, RegExp>> = Object.freeze({
  AT: /^ATU\d{8}$/,
  BE: /^BE[01]\d{9}$/,
  BG: /^BG\d{9,10}$/,
  CY: /^CY\d{8}[A-Z]$/,
  CZ: /^CZ\d{8,10}$/,
  DE: /^DE\d{9}$/,
  DK: /^DK\d{8}$/,
  EE: /^EE\d{9}$/,
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^FI\d{8}$/,
  FR: /^FR[A-Z0-9]{2}\d{9}$/,
  GR: /^EL\d{9}$/,
  HR: /^HR\d{11}$/,
  HU: /^HU\d{8}$/,
  IE: /^IE(?:\d{7}[A-W][A-IW]?|\d[A-Z*+]\d{5}[A-W])$/,
  IT: /^IT\d{11}$/,
  LT: /^LT(?:\d{9}|\d{12})$/,
  LU: /^LU\d{8}$/,
  LV: /^LV\d{11}$/,
  MT: /^MT\d{8}$/,
  NL: /^NL\d{9}B\d{2}$/,
  PL: /^PL\d{10}$/,
  PT: /^PT\d{9}$/,
  RO: /^RO\d{2,10}$/,
  SE: /^SE\d{12}$/,
  SI: /^SI\d{8}$/,
  SK: /^SK\d{10}$/,
});

/** Whitespace and punctuation removed, upper-cased. What VIES would be sent. */
export function normaliseVatId(raw: string): string {
  return raw.replace(/[\s.\-/]/g, '').toUpperCase();
}

/**
 * Whether a VAT number is shaped like one of its country's.
 *
 * Never sufficient for the reverse charge on its own — see the module header.
 */
export function vatIdLooksWellFormed(country: string, vatId: string): boolean {
  const pattern = VAT_ID_PATTERNS[country.toUpperCase()];
  return pattern === undefined ? false : pattern.test(normaliseVatId(vatId));
}

/**
 * The record of a VIES check, or its absence.
 *
 * `'unverified'` is the state every profile is in today and is not a failure: no
 * check has been made because this deployment makes no outbound calls. It is
 * distinct from `'invalid'`, which is VIES having answered "no" — one of them
 * becomes `'validated'` the day a check runs, and the other is a customer who
 * needs to correct their number.
 */
export interface VatIdValidation {
  status: 'validated' | 'unverified' | 'invalid';
  /** ISO 8601 UTC, or `null` when no check has ever been attempted. */
  checkedAt: string | null;
  /** `'vies'`, or `'manual'` for a check somebody performed and recorded by hand. */
  source: string | null;
  /** VIES returns a consultation number; it is the evidence the relief rests on. */
  reference: string | null;
}

export const UNVERIFIED_VAT_ID: VatIdValidation = Object.freeze({
  status: 'unverified',
  checkedAt: null,
  source: null,
  reference: null,
});

/** Who we are, for VAT purposes. Configuration; there is no default. */
export interface SupplierTaxProfile {
  /** ISO-3166-1 alpha-2, upper case. */
  country: string;
  vatId: string | null;
  /**
   * Whether we are registered for the One Stop Shop.
   *
   * Decides nothing about the *rate* — destination rates apply either way — but
   * it decides whether we may declare that VAT through a single return or need a
   * registration in each member state. Recorded on the invoice because an
   * OSS-declared supply and a locally-registered one are not the same document.
   */
  ossRegistered: boolean;
  /**
   * Whether cross-border B2C turnover is below the €10,000 union-wide threshold.
   *
   * Below it, a supplier established in one member state **may elect** to keep
   * charging its domestic rate on cross-border B2C supplies rather than the
   * destination rate. It is an election, not a default, and it is the option a
   * business of this size would plausibly take — so it is modelled rather than
   * assumed away, and it defaults to `false` (destination rates), which is the
   * treatment that is correct at any turnover.
   */
  belowUnionThreshold: boolean;
}

/** Who the customer is, for VAT purposes. */
export interface CustomerTaxProfile {
  accountId: string;
  /** ISO-3166-1 alpha-2, upper case. Where the customer belongs. */
  country: string;
  /**
   * `business` only when we hold evidence of it — which for these purposes is a
   * VAT identification number. A customer who says they are a business and
   * supplies no number is treated as a consumer, because that is what the
   * evidence supports.
   */
  customerKind: 'business' | 'consumer';
  vatId: string | null;
  validation: VatIdValidation;
}

export type VatTreatmentKind =
  /** Supplier and customer in the same member state. Domestic rate. */
  | 'domestic'
  /** Cross-border EU B2B with a validated number. Zero-rated; customer accounts. */
  | 'reverse_charge'
  /** Cross-border EU B2C. Destination member state's rate, declared through OSS. */
  | 'oss_destination'
  /** Customer outside the EU. Outside the scope of EU VAT. */
  | 'outside_scope';

export interface VatTreatment {
  kind: VatTreatmentKind;
  /** Basis points. `0` for reverse charge and outside-scope. */
  rateBasisPoints: number;
  /** The member state whose rate was applied, or `null` when none was. */
  rateCountry: string | null;
  /**
   * The sentence that must appear on the invoice.
   *
   * Not decoration: for a reverse charge, the absence of the legend is what makes
   * an otherwise-correct zero-rated invoice invalid, and the customer's own
   * deduction depends on it.
   */
  legend: string | null;
  /**
   * Why this treatment and not another, in plain words — including the reasons
   * that are about *our* limitations rather than about the law.
   *
   * The one that matters most is the unverified VAT number: a business charged
   * consumer VAT deserves to read why on the document rather than to discover it
   * in a support thread.
   */
  notes: string[];
  rates: VatRatesProvenance;
}

const REVERSE_CHARGE_LEGEND =
  'Reverse charge — VAT to be accounted for by the recipient under Article 196 of Council ' +
  'Directive 2006/112/EC.';

const OUTSIDE_SCOPE_LEGEND =
  'Outside the scope of EU VAT — electronically supplied service to a customer established ' +
  'outside the European Union (Article 44 / Article 59, Council Directive 2006/112/EC).';

/**
 * Decide the VAT treatment for one supply.
 *
 * Pure, total, and ordered from the most specific case outwards. Every branch
 * that declines a relief records *why* in {@link VatTreatment.notes}, because
 * the expensive version of this function is one that silently picks the
 * defensible option and leaves nobody able to explain the number.
 */
export function resolveVatTreatment(
  supplier: SupplierTaxProfile,
  customer: CustomerTaxProfile
): VatTreatment {
  const supplierCountry = supplier.country.toUpperCase();
  const customerCountry = customer.country.toUpperCase();
  const notes: string[] = [];

  // Outside the EU. Place of supply follows the customer, so no EU VAT is
  // chargeable — which is not the same as no tax being due anywhere.
  if (!isEuMemberState(customerCountry)) {
    notes.push(
      `Customer is established in ${customerCountry}, outside the EU, so the place of supply ` +
        'of this electronically supplied service is outside the EU.'
    );
    notes.push(
      'No EU VAT is charged. A registration obligation may still exist in the customer\'s own ' +
        'country — several operate a non-resident digital services regime with no threshold. ' +
        'That is not assessed here.'
    );
    return {
      kind: 'outside_scope',
      rateBasisPoints: 0,
      rateCountry: null,
      legend: OUTSIDE_SCOPE_LEGEND,
      notes,
      rates: VAT_RATES_PROVENANCE,
    };
  }

  // Domestic. The reverse charge is a cross-border mechanism and does not apply
  // within one member state, whatever the customer's status.
  if (customerCountry === supplierCountry) {
    notes.push(
      `Customer and supplier are both established in ${supplierCountry}, so this is a domestic ` +
        'supply taxed at the domestic standard rate.'
    );
    return {
      kind: 'domestic',
      rateBasisPoints: rateFor(supplierCountry),
      rateCountry: supplierCountry,
      legend: null,
      notes,
      rates: VAT_RATES_PROVENANCE,
    };
  }

  // Cross-border, inside the EU. B2B with a validated number is the only path to
  // the reverse charge, and every way of failing it is stated.
  if (customer.customerKind === 'business') {
    const reason = reverseChargeRefusal(customer, customerCountry);
    if (reason === null) {
      notes.push(
        `Cross-border supply to a business in ${customerCountry} with a VAT number validated ` +
          `on ${customer.validation.checkedAt} (${customer.validation.source}` +
          `${customer.validation.reference ? `, ref ${customer.validation.reference}` : ''}). ` +
          'The recipient accounts for the VAT.'
      );
      return {
        kind: 'reverse_charge',
        rateBasisPoints: 0,
        rateCountry: null,
        legend: REVERSE_CHARGE_LEGEND,
        notes,
        rates: VAT_RATES_PROVENANCE,
      };
    }
    notes.push(reason);
    notes.push(
      'The reverse charge has therefore not been applied and VAT has been charged as if to a ' +
        'consumer. This over-charges rather than under-charges: it is refundable to the ' +
        'customer once the number is validated, whereas an unsupported reverse charge is a ' +
        'liability to a tax authority.'
    );
  }

  // Cross-border B2C — and cross-border B2B that could not claim the relief.
  if (supplier.belowUnionThreshold) {
    notes.push(
      `Supplier has elected the €10,000 union-wide threshold simplification, so the ` +
        `${supplierCountry} domestic rate is applied rather than the ${customerCountry} rate. ` +
        'That election ceases to be available in the year the threshold is exceeded.'
    );
    return {
      kind: 'domestic',
      rateBasisPoints: rateFor(supplierCountry),
      rateCountry: supplierCountry,
      legend: null,
      notes,
      rates: VAT_RATES_PROVENANCE,
    };
  }

  notes.push(
    `Place of supply is ${customerCountry}, so that member state's standard rate applies.` +
      (supplier.ossRegistered
        ? ' Declared through the One Stop Shop.'
        : ' NOT declared through the One Stop Shop — the supplier is not registered for it, so ' +
          'this supply needs a VAT registration in the customer\'s member state. Resolve before ' +
          'issuing.')
  );

  return {
    kind: 'oss_destination',
    rateBasisPoints: rateFor(customerCountry),
    rateCountry: customerCountry,
    legend: null,
    notes,
    rates: VAT_RATES_PROVENANCE,
  };
}

/**
 * Why this business cannot have the reverse charge, or `null` if it can.
 *
 * Split out so each refusal reads as its own sentence on the invoice, and so the
 * test can name them individually. The order matters only for which single
 * reason a customer is shown first; each is sufficient on its own.
 */
function reverseChargeRefusal(customer: CustomerTaxProfile, country: string): string | null {
  if (customer.vatId === null || customer.vatId.trim() === '') {
    return (
      `Customer is recorded as a business in ${country} but holds no VAT identification ` +
      'number, which is the evidence the reverse charge requires.'
    );
  }

  if (!vatIdLooksWellFormed(country, customer.vatId)) {
    return (
      `Customer's VAT number ${normaliseVatId(customer.vatId)} is not shaped like a ` +
      `${country} number, so it cannot be the basis of a reverse charge.`
    );
  }

  if (customer.validation.status === 'invalid') {
    return (
      `Customer's VAT number ${normaliseVatId(customer.vatId)} was checked on ` +
      `${customer.validation.checkedAt} and is not valid.`
    );
  }

  if (customer.validation.status !== 'validated') {
    return (
      `Customer's VAT number ${normaliseVatId(customer.vatId)} is well-formed but has never ` +
      'been validated against VIES. This deployment makes no outbound network calls ' +
      '(Board ruling 2026-08-12, LAN-only), so no number here can be validated yet.'
    );
  }

  return null;
}

function rateFor(country: string): number {
  const rate = EU_VAT_STANDARD_RATES[country];
  if (rate === undefined) {
    // Unreachable while `isEuMemberState` and this table read the same object,
    // and asserted rather than defaulted because a default rate is a wrong
    // number nobody questions.
    throw new Error(`No VAT rate recorded for ${country}, which isEuMemberState accepted.`);
  }
  return rate;
}

/** VAT on a net amount. Half-up, which is the one place this module rounds up — see `money.ts`. */
export function vatOn(net: Money, treatment: VatTreatment): Money {
  return money(roundHalfUpDiv(net.minor, treatment.rateBasisPoints, BASIS_POINTS_PER_UNIT));
}

/** `20.00%`, for the invoice document and the CLI. */
export function formatRate(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2)}%`;
}

/*
 * ---------------------------------------------------------------------------
 * Supplier configuration
 * ---------------------------------------------------------------------------
 */

export const SUPPLIER_ENV = {
  country: 'BILLING_SUPPLIER_COUNTRY',
  vatId: 'BILLING_SUPPLIER_VAT_ID',
  ossRegistered: 'BILLING_SUPPLIER_OSS_REGISTERED',
  belowUnionThreshold: 'BILLING_SUPPLIER_BELOW_UNION_THRESHOLD',
} as const;

export interface SupplierResolution {
  status: 'configured' | 'unconfigured';
  supplier: SupplierTaxProfile | null;
  reason: string | null;
}

/**
 * Read our own tax position from the environment.
 *
 * No default country, for the same reason `resolveApiKeysDbPath` has no default
 * path: every branch above turns on which member state we are established in,
 * and a guessed one produces a confidently wrong rate on every invoice. An
 * unconfigured supplier is a state the CLI reports and the invoice builder
 * refuses, not one it works around.
 */
export function resolveSupplier(env: NodeJS.ProcessEnv = process.env): SupplierResolution {
  const country = (env[SUPPLIER_ENV.country] ?? '').trim().toUpperCase();

  if (country === '') {
    return {
      status: 'unconfigured',
      supplier: null,
      reason:
        `${SUPPLIER_ENV.country} is not set. Every VAT decision turns on which member state ` +
        'the supplier is established in, and there is no safe default: guessing it would put a ' +
        'confidently wrong rate on every invoice.',
    };
  }

  if (!isEuMemberState(country)) {
    return {
      status: 'unconfigured',
      supplier: null,
      reason:
        `${SUPPLIER_ENV.country} is "${country}", which is not an EU member state in the ` +
        `${VAT_RATES_AS_OF} table. This module implements EU VAT only; a supplier established ` +
        'elsewhere needs a different set of rules, not a different constant.',
    };
  }

  return {
    status: 'configured',
    reason: null,
    supplier: {
      country,
      vatId: (env[SUPPLIER_ENV.vatId] ?? '').trim() || null,
      ossRegistered: readBoolean(env, SUPPLIER_ENV.ossRegistered),
      belowUnionThreshold: readBoolean(env, SUPPLIER_ENV.belowUnionThreshold),
    },
  };
}

/** `true`/`1`/`yes`, case-insensitively. Anything else, including unset, is false. */
function readBoolean(env: NodeJS.ProcessEnv, name: string): boolean {
  return ['true', '1', 'yes'].includes((env[name] ?? '').trim().toLowerCase());
}
