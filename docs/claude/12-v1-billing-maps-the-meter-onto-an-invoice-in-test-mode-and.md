> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# `/v1` billing maps the meter onto an invoice, in test mode, and reconciles

## `/v1` billing maps the meter onto an invoice, in test mode, and reconciles

ABL-307, in `server/src/v1/billing/`, driven by `npm run billing -- <command>`.
It models plan/subscription state, maps a closed month of metered usage onto the
invoice we *would* raise, accounts for overage and EU VAT, and reconciles the
three. **Nothing here issues, sends or charges anything**: every document carries
`mode: 'test'` and a not-for-issue notice, and no code path removes either.

**No price list is committed.** Board Decision 1 (tier structure and price
points) is open, so `priceBook.ts` ships the *shape* and reads the values from
`BILLING_PRICE_BOOK_PATH`. Unset — the correct setting today — the CLI names the
open decision and prints the shape to fill in, and everything except the amounts
still works. What makes that safe rather than merely compliant is
`checkAgainstPlanLimits`: a configured book is validated against
`quota/planLimits.ts` and **refused** if they disagree, because ABL-302 already
enforces two numbers that are functions of price — the included allowance, and
the request at which a Professional account is refused, which `softOverage()`
derived from a base price and an overage rate. The gate serves against one set of
figures and the invoice charges against the other; a price change has to move
both in the same reviewed diff.

**Subscription state is a history, not a column.** `accounts.plan` answers "what
may this key do now", which is all a gate needs and is overwritten by an upgrade.
An invoice asks what the account was entitled to on the 14th, so
`billing_subscription_change` is append-only and `segmentsForMonth` replays it.
Segments prorate by exact elapsed milliseconds, and their durations sum to
exactly the month — which is what makes a whole month on one plan cost exactly
the plan fee, with no remainder to explain. There is deliberately no `trialing`
status: a trial is a plan priced at zero, which needs no branch in the
arithmetic.

**Money is integers and rounds one way.** Everything the customer owes rounds
*down* (`floorDiv`) — prorated fees, whole-thousand overage — following the rule
`usageStore.ts` states: an invoice slightly low is margin we absorb, one slightly
high is a refund and a customer who checks every future invoice by hand. VAT is
the single exception and rounds half-up, because it is collected on a tax
authority's behalf and is not ours to absorb.

**EU VAT refuses the reverse charge on an unvalidated number, on purpose.**
Cross-border B2B is zero-rated only against a VAT number VIES confirms, and VIES
is an outbound call this LAN-only deployment does not make — so no number here is
validated and `vat.ts` charges destination VAT instead, saying so on the
document. That over-charges, which is refundable; an unsupported reverse charge
is a liability discovered at audit.

**`billing:reconcile` is the acceptance bar, and its output is an attribution
rather than a delta.** Every metered request lands in exactly one place:
`rollup.billable + rollup.lateBillable + unrolled.billable`. Anything left over
is `unexplained` and blocking; the three designed causes are reported separately
and never netted off. Two things it deliberately reports rather than hides: a
month past the 13-month event retention is `not_corroborable` (the check did not
run — saying "0 discrepancies" would claim it did), and the meter's buffered-flush
loss window is stated as unmeasured, because those requests never reached
`usage_events` and no query can see them.

**Billing is unreachable from the serving process, as a whole directory.**
`publicAppGraph.test.ts` asserts `v1/billing/` is absent from both entrypoints —
stricter than the module-by-module list beside it, and affordable because nothing
here has a request-path role. `sqliteBillingStore.ts` opens its own handle on
`API_KEYS_DB_PATH` and is reached from `billingCli.ts` alone, so it is absent
from the list of database-opening modules that test names — the assertion is
about which modules are in it, not how many, and the count has moved twice since
this paragraph was written.

**Webhooks are design only** — Board ruling 2026-08-12, LAN-only. See
`WEBHOOKS-DESIGN.md` beside the code. Its useful conclusion: the constraint costs
latency, not correctness. `PaymentProvider.fetchSubscription` polls for the same
state a callback would push, and ABL-297 §6.5 already puts a human between a
failed payment and any suspension.
