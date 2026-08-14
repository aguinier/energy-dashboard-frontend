/**
 * Per-series source and licence — the field that discharges a licence
 * obligation, not a documentation nicety.
 *
 * ## This is contractual
 *
 * ToS §7.3 (ABL-297, Board-approved 2026-08-12) tells a subscriber:
 *
 * > *Each data series in a response carries a source and attribution field
 * > identifying its origin and the applicable licence, so that you can render
 * > the correct attribution programmatically rather than having to remember
 * > which fields came from where.*
 *
 * §7.2 explains why that sentence cannot be softened: the attribution
 * requirement flows from CC-BY 4.0 upstream, *we are not able to waive it*, and
 * we would be in breach if we purported to. So the field below is the mechanism
 * by which we pass the obligation on. An endpoint that returns series data
 * without it is not a complete implementation — it is a document we are already
 * failing, readable off the first response body a customer looks at.
 *
 * §8.1 is the other half and is why the field is **per series** rather than per
 * response: *"Different parts of a single response may be subject to different
 * terms. The per-series source field (§7.3) tells you which is which."* A
 * generation response carries up to 21 series and a forecast response carries
 * ours; a single response-level licence statement would be wrong for one of
 * them whichever way it was written.
 *
 * ## Why our own forecasts carry it too
 *
 * Marked as ours, with `attribution_required: false`. The point of putting the
 * field on a series that needs no attribution is that a subscriber can then
 * decide **mechanically** — `if (series.source.attribution_required)` — instead
 * of maintaining their own list of which of our fields came from where. A field
 * present only on the series that need it would have to be tested for absence,
 * and "absent" is the same shape as "we forgot".
 *
 * ## One thing a reviewer should check rather than take from me
 *
 * {@link ABLE_FORECAST} asserts that our model output is ours and needs no
 * ENTSO-E attribution. That is the ToS's own position — §2 defines Forecast
 * Output as *"Model-generated values produced by Able Energy … Our intellectual
 * property"* and §7.1 attaches the attribution duty to Observation Output — so
 * this file implements the approved document rather than taking a view. If
 * counsel later concludes that CC-BY 4.0's attribution term reaches our model
 * output as adapted material, the change is the one constant below and every
 * forecast response starts carrying the ENTSO-E line. Flagged here because it is
 * a legal question wearing a `const`, and the cost of being wrong is a breach
 * rather than a bug.
 */

/** The licences this API can serve under. Two today; a third is a decision, not a default. */
export type LicenceId = 'CC-BY-4.0' | 'proprietary';

/**
 * What a series says about where it came from.
 *
 * Every field is a constant chosen here. Nothing is interpolated from a request
 * or from a database value, which keeps this out of the reflected-input class
 * `publicErrors.ts` was inverted to close — and means the string a subscriber
 * renders is one we wrote, not one an upstream row could rewrite.
 */
export interface SeriesSource {
  /** Stable machine handle. Safe to branch on; the display name is not. */
  id: 'entsoe' | 'able';
  name: string;
  licence: LicenceId;
  /** The licence deed, or `null` where the licence is these Terms rather than a public one. */
  licence_url: string | null;
  /**
   * Whether the subscriber must attribute when they republish.
   *
   * The field to branch on. It is not derivable from `licence` by a client
   * without hardcoding a licence table, which is exactly the remembering §7.3
   * exists to remove.
   */
  attribution_required: boolean;
  /**
   * The exact line to render, or `null` when none is required.
   *
   * Wording taken verbatim from the ToS §7.1 example so that what we tell a
   * subscriber to render and what we hand them to render cannot drift.
   */
  attribution: string | null;
}

/**
 * ENTSO-E Transparency Platform, CC-BY 4.0.
 *
 * Applies to every observation series: `energy_load`, `energy_price` and every
 * production type in `energy_generation`. All three are ENTSO-E documents
 * ingested by the sibling `energy-data-gathering` module.
 */
export const ENTSOE_OBSERVATION: SeriesSource = {
  id: 'entsoe',
  name: 'ENTSO-E Transparency Platform',
  licence: 'CC-BY-4.0',
  licence_url: 'https://creativecommons.org/licenses/by/4.0/',
  attribution_required: true,
  attribution: 'Source: ENTSO-E Transparency Platform, licensed under CC-BY 4.0, via Able Energy.',
};

/**
 * Able Energy model output.
 *
 * `licence: 'proprietary'` and `licence_url: null` rather than a link to the
 * ToS: the URL field means "the public licence deed governing this series", and
 * pointing it at our own Terms would read as though the Terms were a licence
 * grant of the same kind as CC-BY. They are not — §5 grants a use licence to a
 * subscriber under contract, which is a different thing from a public licence a
 * downstream recipient can rely on.
 */
export const ABLE_FORECAST: SeriesSource = {
  id: 'able',
  name: 'Able Energy',
  licence: 'proprietary',
  licence_url: null,
  attribution_required: false,
  attribution: null,
};
