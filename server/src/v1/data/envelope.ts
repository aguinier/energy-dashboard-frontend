import type { SeriesDefinition } from './series.js';
import type { StreamFreshness } from './freshnessMap.js';

/**
 * The response envelope: `{ data, meta, links }`, and the rules that keep each
 * part honest.
 *
 * Deliberately **not** the internal `{ success, data, meta }` shape
 * (`app.ts:52-56`). A public API signals failure with the HTTP status and a
 * typed error body; a `success: false` inside a 200 is a second, redundant
 * error channel that clients forget to check — and this one already bit us the
 * other way round, with HTML arriving where JSON was expected.
 */

/**
 * Why a collection is empty — or that it is not.
 *
 * ABL-293 §2a, "Partial data", rule 3: *an empty array carries a reason.* The
 * internal `routes/coreNetPosition.ts:17-27` already does this well, with
 * `out_of_core` / `not_captured` / `no_data` as three different claims; this
 * generalises it, because to a customer an empty array is otherwise
 * indistinguishable from an outage on our side.
 *
 * - `ok` — rows were returned. Says nothing about whether there are holes
 *   *within* them; that is what `resolution_uniform` and `/v1/catalog/coverage`
 *   are for.
 * - `out_of_scope` — we hold nothing for this zone and stream at any time. The
 *   pair is not part of our coverage, and no window will help.
 * - `no_data` — we hold this pair, but the requested window falls entirely
 *   outside the period we hold. Asking before our first row or after our last.
 * - `upstream_gap` — we hold this pair and the window falls inside the period we
 *   hold, and it is still empty. Upstream did not publish it. **This is the one
 *   that must not read as our failure**: MK's `energy_load` has rows on 30 of 46
 *   dates including a seven-day hole, and AL/MK go days between publications.
 * - `not_captured` — reserved, and not produced by any endpoint in this release.
 *   It is the answer for a series we deliberately do not capture for a zone;
 *   net position is the case it exists for and it is not on this surface.
 */
export type Coverage = 'ok' | 'no_data' | 'out_of_scope' | 'upstream_gap' | 'not_captured';

/**
 * Decide the coverage of an empty page.
 *
 * Called only when nothing came back — a page with rows is `ok` by definition.
 * The comparison is string-lexicographic on RFC 3339 UTC instants, which is
 * exactly ordering by time as long as every value is second-precision UTC with
 * a `Z`. Everything reaching here has been through `toIsoSecond`, so it is.
 */
export function emptyCoverage(
  window: { fromIso: string; toIso: string },
  held: { data_from: string | null; data_through: string | null }
): Coverage {
  if (held.data_from === null || held.data_through === null) return 'out_of_scope';

  // The window is half-open, so it overlaps what we hold when it starts before
  // our last row and ends after our first.
  const overlaps = window.fromIso <= held.data_through && window.toIso > held.data_from;
  return overlaps ? 'upstream_gap' : 'no_data';
}

/**
 * The `series` block: one entry per numeric field on a data row.
 *
 * This is the ToS §7.3 field, and it is a per-field array rather than a single
 * response-level object because §8.1 says a single response may mix provenance:
 * *"Different parts of a single response may be subject to different terms. The
 * per-series source field tells you which is which."*
 */
export interface SeriesDescriptor {
  field: string;
  unit: string;
  signed: boolean;
  source: SeriesDefinition['source'];
}

export function describeSeries(series: readonly SeriesDefinition[]): SeriesDescriptor[] {
  return series.map(({ field, unit, signed, source }) => ({ field, unit, signed, source }));
}

/**
 * The observed spacing of a page, as an ISO 8601 duration.
 *
 * `/v1` does **not** accept a `resolution` request parameter and does not
 * aggregate. The internal `granularity=hourly` is a raw pass-through that does
 * not group (`services/loadService.ts:15-27`), and shipping that under a public
 * name would sell an aggregation we do not perform. So this field *reports*
 * rather than *promises*: it is the modal gap between consecutive timestamps in
 * the rows actually returned.
 *
 * `resolution_uniform` beside it is what stops the modal value being read as a
 * guarantee. A hole in the series makes it `false` — which is the useful
 * signal, because gaps are gaps: this API never interpolates, forward-fills or
 * carries a value across a missing interval (that habit is how 216 fabricated
 * `net_position` rows reached the database, ABL-181/ABL-67).
 *
 * Both are `null` on a page of fewer than two rows, where there is no spacing
 * to observe. `null` rather than a guess — absent means absent.
 */
export interface ObservedResolution {
  resolution: string | null;
  resolution_uniform: boolean | null;
}

export function observeResolution(isoTimestamps: readonly string[]): ObservedResolution {
  if (isoTimestamps.length < 2) return { resolution: null, resolution_uniform: null };

  const gaps: number[] = [];
  for (let i = 1; i < isoTimestamps.length; i += 1) {
    gaps.push(Date.parse(isoTimestamps[i]) - Date.parse(isoTimestamps[i - 1]));
  }

  const counts = new Map<number, number>();
  for (const gap of gaps) counts.set(gap, (counts.get(gap) ?? 0) + 1);

  let modal = gaps[0];
  let best = 0;
  for (const [gap, count] of counts) {
    // Ties break toward the smaller gap: on a page split evenly between two
    // spacings, the finer one is the resolution and the coarser one is a hole
    // in it.
    if (count > best || (count === best && gap < modal)) {
      modal = gap;
      best = count;
    }
  }

  return {
    resolution: isoDuration(modal),
    resolution_uniform: gaps.every((gap) => gap === modal),
  };
}

/**
 * Milliseconds -> `PT15M`, `PT1H`, `P1D`.
 *
 * Only the forms this data actually produces are spelled; anything else falls
 * back to seconds (`PT3600S`), which is still a valid ISO 8601 duration. A
 * cosmetic fallback is the right failure here: a duration a client cannot parse
 * would be worse than an ugly one, and an unexpected spacing is information
 * rather than an error.
 */
export function isoDuration(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return 'PT0S';
  const seconds = Math.round(ms / 1000);
  if (seconds % 86_400 === 0) return `P${seconds / 86_400}D`;
  if (seconds % 3_600 === 0) return `PT${seconds / 3_600}H`;
  if (seconds % 60 === 0) return `PT${seconds / 60}M`;
  return `PT${seconds}S`;
}

/**
 * The freshness block as it appears on the wire.
 *
 * `generated_at` is added here, from a clock the **handler** passes in. ABL-293
 * §2g.F: stamping it in a serializer or in middleware would recompute it on
 * every cache replay and report a cached body as freshly computed, wrong by up
 * to the TTL. There is no response cache on this surface today, and building
 * the field so that adding one cannot make it lie costs a parameter.
 */
export interface FreshnessBlock extends StreamFreshness {
  generated_at: string;
}

export interface EnvelopeMeta {
  /** The endpoint that produced this, as a stable id — `observations.load`. */
  resource: string;
  zone: string;
  /** Echoes the window actually served. Half-open: `from` included, `to` not. */
  from: string;
  to: string;
  coverage: Coverage;
  row_count: number;
  /** The cap that was applied. Present even when it did not bite (ABL-293 §2a). */
  row_limit: number;
  /**
   * Whether the cap bit.
   *
   * Explicit rather than inferable, deliberately: a caller must never have to
   * derive truncation from `row_count === row_limit`, which is also true of a
   * window that happens to hold exactly that many rows.
   */
  truncated: boolean;
  resolution: string | null;
  resolution_uniform: boolean | null;
  /** ToS §7.3. One entry per numeric field on a data row. */
  series: SeriesDescriptor[];
  freshness: FreshnessBlock;
  /** Set where a stream excludes rows for a stated reason. Absent means nothing was excluded. */
  excluded?: ExcludedNote[];
}

/**
 * A row class this API deliberately does not serve, named on the response that
 * would otherwise have contained it.
 *
 * Silent exclusion is the failure mode this exists to avoid: a customer
 * comparing our row count against ENTSO-E's own and finding it short deserves to
 * find the reason in the response rather than in a support thread.
 */
export interface ExcludedNote {
  reason: string;
  detail: string;
}

export interface Envelope<Row> {
  data: Row[];
  meta: EnvelopeMeta;
  links: { self: string; next: string | null };
}
