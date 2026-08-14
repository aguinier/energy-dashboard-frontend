/**
 * Money, as integers, and the two rounding rules this module is allowed to use.
 *
 * Every amount in the billing module is an **integer number of minor units** —
 * euro cents — and never a `number` of euro. That is not fastidiousness: at
 * ABL-302's published overage rate a single request is a tenth of a cent, an
 * invoice sums hundreds of thousands of them, and `0.1 + 0.2 !== 0.3` is enough
 * to make two independently-correct computations of the same invoice disagree by
 * a cent. A cent of disagreement between the invoice we send and the figure we
 * reconcile against is indistinguishable, from the outside, from a billing bug.
 *
 * ## The two rounding rules, and why there are exactly two
 *
 * `usageStore.ts` states the rule the whole commercial surface is written to:
 * *"An invoice that is slightly low is a margin we absorb quietly; an invoice
 * that is slightly high is a refund, an apology and a customer who now checks
 * every future invoice by hand."* That gives one rule and one exception.
 *
 * - **What we charge rounds down.** {@link floorDiv} is used for every step that
 *   decides an amount the customer owes us — prorated base fees, overage
 *   thousands, allowance shares. Each such step errs in the customer's favour by
 *   at most one minor unit, and there are few enough steps that the total error
 *   is bounded and stated rather than accumulated blindly.
 *
 * - **VAT rounds half-up.** {@link roundHalfUpDiv}, and this is the exception,
 *   because VAT is not our margin to absorb. The amount is computed for a tax
 *   authority under a statutory rate; rounding it down systematically would
 *   under-declare an amount we collect on someone else's behalf, on every
 *   invoice, in the same direction. Commercial half-up rounding is what the
 *   authorities expect and it is the only place in this module where a figure is
 *   allowed to move up.
 *
 * Both take integer numerator and denominator and never build an intermediate
 * float, so neither can produce a value that depends on the order the terms were
 * written in.
 */

/**
 * The only currency this module handles.
 *
 * A constant rather than a parameter threaded through every signature, because
 * multi-currency is not a formatting change: it is an FX-rate source, a rate
 * date on every invoice, a rounding unit that is not always two decimal places,
 * and a decision about which currency a *quota* is denominated in. None of that
 * is ABL-307's, and a `currency` parameter that is always `'EUR'` would suggest
 * the question had been thought about when it has not. The field is carried on
 * {@link Money} so an invoice document says which currency it is in — a document
 * that omits it is not readable by a human or by an accountant.
 */
export const BILLING_CURRENCY = 'EUR' as const;
export type BillingCurrency = typeof BILLING_CURRENCY;

/** Minor units per major unit. Two decimal places, which is EUR's. */
export const MINOR_UNITS_PER_MAJOR = 100;

export interface Money {
  /** Integer minor units. Always an integer; {@link money} enforces it. */
  minor: number;
  currency: BillingCurrency;
}

/**
 * Build a {@link Money}, refusing anything that is not a whole minor unit.
 *
 * A throw rather than a silent `Math.round`, because a non-integer arriving here
 * means some caller did float arithmetic on an amount, and rounding it away
 * would hide the one thing worth knowing. The error names the value so the
 * offending step is findable.
 */
export function money(minor: number): Money {
  if (!Number.isInteger(minor)) {
    throw new Error(
      `Money must be a whole number of minor units, and is ${minor}. Some caller did ` +
        'arithmetic in euro rather than in cents; find it rather than rounding here.'
    );
  }
  return { minor, currency: BILLING_CURRENCY };
}

export const ZERO: Money = { minor: 0, currency: BILLING_CURRENCY };

export function addMoney(...amounts: readonly Money[]): Money {
  return money(amounts.reduce((sum, amount) => sum + amount.minor, 0));
}

/**
 * `⌊a × numerator / denominator⌋`, in integers, for an amount we charge.
 *
 * Integer throughout: the multiply happens before the divide, so the only
 * precision loss is the single deliberate floor at the end. Written as a named
 * function rather than inline so that every place an amount rounds down is
 * greppable, and so that changing one of them to round up is a diff somebody
 * reviews rather than an operator precedence change nobody notices.
 *
 * `Math.floor` and not `Math.trunc`: they agree on the non-negative amounts this
 * module produces, and they disagree on negatives — where `trunc` rounds *up*
 * toward zero, which would be the wrong direction for a credit note. There are
 * no credit notes yet; there is also no reason to leave the trap armed.
 */
export function floorDiv(value: number, numerator: number, denominator: number): number {
  assertIntegers('floorDiv', value, numerator, denominator);
  if (denominator === 0) throw new Error('floorDiv: denominator is zero.');
  return Math.floor((value * numerator) / denominator);
}

/**
 * `round(a × numerator / denominator)`, half away from zero. VAT only.
 *
 * `Math.round` is half-*up* — it sends `-0.5` to `-0` — which is a different
 * function on negatives and not the one a tax computation wants. The explicit
 * form here is symmetric, so a credit note's VAT would round to the same
 * magnitude as the invoice's.
 */
export function roundHalfUpDiv(value: number, numerator: number, denominator: number): number {
  assertIntegers('roundHalfUpDiv', value, numerator, denominator);
  if (denominator === 0) throw new Error('roundHalfUpDiv: denominator is zero.');
  const scaled = value * numerator;
  const sign = scaled < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(scaled) + denominator / 2) / denominator);
}

function assertIntegers(fn: string, ...values: readonly number[]): void {
  for (const value of values) {
    if (!Number.isInteger(value)) {
      throw new Error(`${fn}: every term must be an integer, and one is ${value}.`);
    }
  }
}

/**
 * `1234` → `"12.34"`. For operator output and invoice documents, never for
 * arithmetic.
 *
 * Built by string surgery on the integer rather than by `minor / 100`, so the
 * rendered figure is exactly the stored one: `/ 100` reintroduces the float this
 * whole module exists to avoid, and does it at the last possible moment, where
 * the resulting cent is the one a customer reads.
 */
export function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  // Three, so that a value under one euro still has a major digit to show:
  // `5` pads to `005` and renders `0.05` rather than `.05`.
  const abs = String(Math.abs(minor)).padStart(3, '0');
  return `${sign}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}

/** `"12.34 EUR"`. */
export function formatMoney(amount: Money): string {
  return `${formatMinor(amount.minor)} ${amount.currency}`;
}

/**
 * Parse `"49"` or `"49.00"` into minor units, refusing anything longer.
 *
 * Used only when reading the operator's price book off disk, which is the one
 * place a human writes an amount into this module. A third decimal place is
 * rejected rather than rounded: a price book saying `0.001` is a person
 * expressing a per-request price in a per-thousand field, and rounding that to
 * zero would serve every overage request free.
 */
export function parseMajorToMinor(raw: unknown, field: string): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new Error(`${field}: ${raw} is not a finite amount.`);
    return parseMajorToMinor(raw.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''), field);
  }
  if (typeof raw !== 'string') {
    throw new Error(`${field}: expected an amount as a number or string, got ${typeof raw}.`);
  }

  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) {
    throw new Error(
      `${field}: "${raw}" is not an amount in ${BILLING_CURRENCY} with at most two decimal ` +
        'places. Prices are written in euro (49, 49.00, 0.10) and stored as cents.'
    );
  }

  const [, sign, major, cents = ''] = match;
  const minor = Number(major) * MINOR_UNITS_PER_MAJOR + Number(cents.padEnd(2, '0'));
  return sign === '-' ? -minor : minor;
}
