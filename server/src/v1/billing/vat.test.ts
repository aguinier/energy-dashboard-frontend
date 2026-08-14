import { describe, it, expect } from 'vitest';
import { money } from './money.js';
import {
  EU_VAT_STANDARD_RATES,
  formatRate,
  isEuMemberState,
  normaliseVatId,
  resolveSupplier,
  resolveVatTreatment,
  SUPPLIER_ENV,
  UNVERIFIED_VAT_ID,
  vatIdLooksWellFormed,
  vatOn,
  type CustomerTaxProfile,
  type SupplierTaxProfile,
  type VatIdValidation,
} from './vat.js';

/**
 * The four treatments, and the one refusal that matters more than the other
 * three put together.
 *
 * A wrongly-applied reverse charge is not a pricing error: it is VAT we did not
 * charge, on a supply where we remain liable for it, discovered at audit. So the
 * test that earns its place here is the one asserting that a *well-formed* VAT
 * number is still not enough — because on a LAN-only deployment with no VIES
 * call, well-formed is all we will ever have.
 */

const supplier: SupplierTaxProfile = {
  country: 'DE',
  vatId: 'DE999999999',
  ossRegistered: true,
  belowUnionThreshold: false,
};

function customer(overrides: Partial<CustomerTaxProfile> = {}): CustomerTaxProfile {
  return {
    accountId: 'acct_test',
    country: 'FR',
    customerKind: 'consumer',
    vatId: null,
    validation: UNVERIFIED_VAT_ID,
    ...overrides,
  };
}

const VALIDATED: VatIdValidation = {
  status: 'validated',
  checkedAt: '2026-07-01T09:00:00.000Z',
  source: 'vies',
  reference: 'WAPIAAAAX123456789',
};

describe('the rate table', () => {
  it('covers the 27 member states and is keyed on ISO country codes', () => {
    expect(Object.keys(EU_VAT_STANDARD_RATES)).toHaveLength(27);
    expect(isEuMemberState('DE')).toBe(true);
    expect(isEuMemberState('de')).toBe(true);
  });

  it('treats an unknown country as non-EU rather than defaulting a rate', () => {
    // The safe direction for a typo: `outside_scope` produces a zero-rated
    // invoice with a legend a human will question. A default rate produces a
    // confident wrong number nobody looks at.
    expect(isEuMemberState('XX')).toBe(false);
    expect(isEuMemberState('GB')).toBe(false);
  });

  it('holds a fractional rate exactly, in basis points', () => {
    expect(EU_VAT_STANDARD_RATES.FI).toBe(2550);
    expect(formatRate(2550)).toBe('25.50%');
  });
});

describe('VAT identification numbers', () => {
  it('normalises the punctuation a customer pastes', () => {
    expect(normaliseVatId(' de 123.456-789 ')).toBe('DE123456789');
  });

  it('knows that Greece uses the EL prefix and not its ISO code', () => {
    // A pattern table keyed on ISO codes with `GR` here rejects every Greek
    // business, and does it silently by falling through to consumer treatment.
    expect(vatIdLooksWellFormed('GR', 'EL123456789')).toBe(true);
    expect(vatIdLooksWellFormed('GR', 'GR123456789')).toBe(false);
  });

  it('checks shape only, and is named so nobody reads it as validity', () => {
    expect(vatIdLooksWellFormed('DE', 'DE123456789')).toBe(true);
    expect(vatIdLooksWellFormed('DE', 'DE12345678')).toBe(false);
    expect(vatIdLooksWellFormed('NL', 'NL123456789B01')).toBe(true);
    expect(vatIdLooksWellFormed('XX', 'XX123456789')).toBe(false);
  });
});

describe('resolveVatTreatment', () => {
  it('taxes a domestic supply at the domestic rate, whatever the customer is', () => {
    for (const kind of ['business', 'consumer'] as const) {
      const treatment = resolveVatTreatment(
        supplier,
        customer({ country: 'DE', customerKind: kind, vatId: 'DE123456789', validation: VALIDATED })
      );
      expect(treatment.kind).toBe('domestic');
      expect(treatment.rateBasisPoints).toBe(1900);
      expect(treatment.legend).toBeNull();
    }
  });

  it('applies the reverse charge to a cross-border business with a validated number', () => {
    const treatment = resolveVatTreatment(
      supplier,
      customer({ customerKind: 'business', vatId: 'FR12345678901', validation: VALIDATED })
    );

    expect(treatment.kind).toBe('reverse_charge');
    expect(treatment.rateBasisPoints).toBe(0);
    // The legend is not decoration: without it an otherwise-correct zero-rated
    // invoice is invalid, and the customer's own deduction depends on it.
    expect(treatment.legend).toContain('Article 196');
  });

  it('REFUSES the reverse charge on a well-formed but unvalidated number', () => {
    // The case this module exists to get right, and the one every account is in
    // today: VIES is an outbound call, this deployment is LAN-only, so no number
    // here has been validated.
    const treatment = resolveVatTreatment(
      supplier,
      customer({ customerKind: 'business', vatId: 'FR12345678901' })
    );

    expect(treatment.kind).toBe('oss_destination');
    expect(treatment.rateBasisPoints).toBe(EU_VAT_STANDARD_RATES.FR);
    expect(treatment.notes.join(' ')).toMatch(/never been validated against VIES/);
    expect(treatment.notes.join(' ')).toMatch(/over-charges rather than under-charges/);
  });

  it('refuses it for a business with no number at all, and says which evidence is missing', () => {
    const treatment = resolveVatTreatment(supplier, customer({ customerKind: 'business' }));
    expect(treatment.kind).toBe('oss_destination');
    expect(treatment.notes.join(' ')).toMatch(/holds no VAT identification number/);
  });

  it('refuses it for a malformed number, and for one VIES answered no to', () => {
    const malformed = resolveVatTreatment(
      supplier,
      customer({ customerKind: 'business', vatId: 'FR1' })
    );
    expect(malformed.kind).toBe('oss_destination');
    expect(malformed.notes.join(' ')).toMatch(/not shaped like a FR number/);

    const invalid = resolveVatTreatment(
      supplier,
      customer({
        customerKind: 'business',
        vatId: 'FR12345678901',
        validation: { ...VALIDATED, status: 'invalid' },
      })
    );
    expect(invalid.kind).toBe('oss_destination');
    expect(invalid.notes.join(' ')).toMatch(/is not valid/);
  });

  it('charges the destination rate to a cross-border consumer', () => {
    const treatment = resolveVatTreatment(supplier, customer({ country: 'HU' }));
    expect(treatment.kind).toBe('oss_destination');
    expect(treatment.rateBasisPoints).toBe(2700);
    expect(treatment.rateCountry).toBe('HU');
  });

  it('flags a destination supply when the supplier is not registered for OSS', () => {
    const treatment = resolveVatTreatment(
      { ...supplier, ossRegistered: false },
      customer({ country: 'HU' })
    );
    expect(treatment.notes.join(' ')).toMatch(/NOT declared through the One Stop Shop/);
  });

  it('honours the €10,000 threshold election by charging the domestic rate', () => {
    // An election rather than a default, and modelled rather than assumed away:
    // a business this size plausibly takes it, and the treatment it produces is
    // a different rate on every cross-border consumer invoice.
    const treatment = resolveVatTreatment(
      { ...supplier, belowUnionThreshold: true },
      customer({ country: 'HU' })
    );
    expect(treatment.kind).toBe('domestic');
    expect(treatment.rateBasisPoints).toBe(1900);
    expect(treatment.notes.join(' ')).toMatch(/€10,000 union-wide threshold/);
  });

  it('puts a non-EU customer outside the scope, and still warns about local registration', () => {
    const treatment = resolveVatTreatment(supplier, customer({ country: 'US' }));
    expect(treatment.kind).toBe('outside_scope');
    expect(treatment.rateBasisPoints).toBe(0);
    expect(treatment.legend).toContain('Outside the scope of EU VAT');
    expect(treatment.notes.join(' ')).toMatch(/registration obligation may still exist/);
  });

  it('carries the rate provenance onto every treatment, unverified', () => {
    // Rendered on the invoice. A draft that silently claimed verified rates
    // would be indistinguishable from a real one at the moment somebody was
    // deciding whether to send it.
    for (const country of ['DE', 'FR', 'US']) {
      const treatment = resolveVatTreatment(supplier, customer({ country }));
      expect(treatment.rates.verified).toBe(false);
      expect(treatment.rates.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('vatOn', () => {
  it('is the half-up rounding of the rate against the net', () => {
    expect(vatOn(money(4900), resolveVatTreatment(supplier, customer({ country: 'DE' }))).minor).toBe(
      931
    );
  });

  it('is zero under a reverse charge and outside the scope', () => {
    const reverse = resolveVatTreatment(
      supplier,
      customer({ customerKind: 'business', vatId: 'FR12345678901', validation: VALIDATED })
    );
    expect(vatOn(money(24_900), reverse).minor).toBe(0);
    expect(vatOn(money(24_900), resolveVatTreatment(supplier, customer({ country: 'JP' }))).minor).toBe(0);
  });
});

describe('resolveSupplier', () => {
  it('refuses to guess a country', () => {
    // No default, for the same reason `resolveApiKeysDbPath` has none: every
    // branch above turns on it, and a guess puts a confidently wrong rate on
    // every invoice.
    const resolution = resolveSupplier({} as NodeJS.ProcessEnv);
    expect(resolution.status).toBe('unconfigured');
    expect(resolution.supplier).toBeNull();
    expect(resolution.reason).toMatch(/no safe default/);
  });

  it('refuses a non-EU supplier rather than pretending the rules apply', () => {
    const resolution = resolveSupplier({
      [SUPPLIER_ENV.country]: 'GB',
    } as NodeJS.ProcessEnv);
    expect(resolution.status).toBe('unconfigured');
    expect(resolution.reason).toMatch(/not an EU member state/);
  });

  it('reads the flags, defaulting both to the treatment that is correct at any turnover', () => {
    const resolution = resolveSupplier({
      [SUPPLIER_ENV.country]: 'de',
      [SUPPLIER_ENV.vatId]: 'DE999999999',
    } as NodeJS.ProcessEnv);

    expect(resolution.status).toBe('configured');
    expect(resolution.supplier).toEqual({
      country: 'DE',
      vatId: 'DE999999999',
      ossRegistered: false,
      belowUnionThreshold: false,
    });
  });

  it('accepts the usual spellings of true', () => {
    for (const value of ['true', 'TRUE', '1', 'yes']) {
      const resolution = resolveSupplier({
        [SUPPLIER_ENV.country]: 'DE',
        [SUPPLIER_ENV.ossRegistered]: value,
      } as NodeJS.ProcessEnv);
      expect(resolution.supplier?.ossRegistered).toBe(true);
    }
  });
});
