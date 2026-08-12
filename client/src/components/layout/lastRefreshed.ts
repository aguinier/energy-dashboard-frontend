import { formatDistanceStrict } from 'date-fns';
import type { IngestDelivery, IngestFreshness, IngestStreamKey, StreamRefresh } from '@/types';

/**
 * The words beside each stream in the "Last refreshed" panel.
 *
 * ABL-295, follow-up A from the ABL-286 provenance audit.
 *
 * WHY THE HEADING IS "LAST REFRESHED" AND NEVER "PUBLISHED"
 *
 * The audit established that **no stream in this database can honestly show an
 * upstream production time**. `publication_timestamp_utc` looks like one and is
 * not: ENTSO-E builds its documents on request and stamps them with the
 * generation time, so the column records when *we fetched*. It drifts up to
 * 39.1 days from the row carrying it, and 80.4% of `energy_load` rows carry one
 * more than a day newer than their own timestamp.
 *
 * So every word here describes **our pipeline**, not the producer. "Published"
 * or "Generated" would be a confident claim about someone else's clock that
 * this database cannot support.
 *
 * WHY TWO VALUES AND NOT ONE
 *
 * A completed pass does not mean rows were stored. Measured 2026-08-12: 2,886
 * of 16,335 completed `price` passes stored nothing, and whole (country,
 * stream) pairs are in that state permanently — GB and UA load have never had a
 * single pass store a row, and 14 of 36 zones have never had one for net
 * position, while all of them were "checked" during the 00:30 UTC pass that
 * morning.
 *
 * Collapsing the two into one number would tell a GB user their load was
 * refreshed this morning. That is this repo's signature defect, so
 * `describeRefresh` refuses to print a timestamp it did not measure: when
 * nothing has ever been stored there is no "refreshed" instant, and the copy
 * says so in words rather than falling back to the check time.
 *
 * WHAT "STORED ROWS" DOES NOT MEAN — THE LIMIT OF THIS SOURCE
 *
 * `records_inserted` counts rows *written*, and the ingest upserts a rolling
 * 7-day window on every pass. So a pass that merely rewrites rows we already
 * held counts as having stored rows, and the series need not have advanced at
 * all. AL load is the live proof: measured 2026-08-12 its
 * `MAX(timestamp_utc)` has been frozen at `2026-08-06 21:45` since the upstream
 * stall (ABL-84), yet every pass since reports 180-660 rows stored, the count
 * falling monotonically (660, 636, 608, ... 180) as the rolling window slides
 * past the frozen data.
 *
 * That is why nothing here says "new data" or "up to date". The panel reports
 * what our pipeline DID, and `REFRESH_PANEL_CAPTION` sends the reader to the
 * freshness pill — which reads `MAX(timestamp_utc)` and is the thing that
 * actually knows how old the data is — for the other half of the answer.
 * (`records_updated` would be the honest place for a rewrite count, but the
 * sibling writer never sets it: 0 of 114,983 rows carry a non-zero value.)
 *
 * Pure, with a colocated test, so the wording can be pinned without a clock or
 * a DOM — this is the entire user-facing surface of the claim.
 */

export interface RefreshCopy {
  /** Stream name as the user knows it — matches the tab where it is drawn. */
  label: string;
  /**
   * The headline: how long ago a pass last STORED rows, or why there is no such
   * time. Never the check time, and never a claim that the series advanced.
   */
  refreshed: string;
  /** The second line: when we last ran, and what that pass stored. */
  checked: string;
  /**
   * `true` when we are running but nothing is arriving. The panel marks these
   * rather than colouring them — see `AbleHeader`'s note on colour-only signals.
   */
  attention: boolean;
}

/** Display order and naming. Each name is the tab the stream is drawn on. */
const STREAM_LABELS: Record<IngestStreamKey, string> = {
  load: 'Load',
  price: 'Day-ahead price',
  generation: 'Generation',
  netPosition: 'Net position',
  tsoLoadForecast: 'TSO load forecast',
  tsoGenerationForecast: 'TSO wind/solar forecast',
};

export const REFRESH_STREAM_ORDER = Object.keys(STREAM_LABELS) as IngestStreamKey[];

/** Which verdicts mean "running, but nothing is coming back". */
const NEEDS_ATTENTION: readonly IngestDelivery[] = ['checked_no_data', 'never_delivered'];

/**
 * Parse one of the log's stamps.
 *
 * `data_ingestion_log` writes Python's `datetime.now(pytz.UTC).isoformat()` —
 * `2026-08-12T00:48:15.882895+00:00`, always with an explicit `+00:00`. That
 * makes it the one timestamp in this codebase `new Date()` handles correctly
 * unaided: the trap `parseStoredTimestamp` exists for server-side is the *bare*
 * space-separated form, which V8 reads as local time. These are never bare.
 * Microseconds are truncated to milliseconds by V8, which is well inside the
 * resolution anything here prints.
 */
function parseLogStamp(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function ago(value: string | null, now: Date): string | null {
  const at = parseLogStamp(value);
  if (!at) return null;
  // A pass cannot finish in the future. If clock skew between the ingest host
  // and the viewer produces one, say "just now" rather than "in 3 minutes".
  return at.getTime() > now.getTime() ? 'just now' : `${formatDistanceStrict(at, now)} ago`;
}

/**
 * One stream's two sentences.
 *
 * The `refreshed` line never falls back to `lastChecked`. That substitution is
 * the whole defect this endpoint was built to prevent, and it would be
 * invisible — a plausible recent timestamp beside a series we have never
 * received.
 */
export function describeRefresh(
  key: IngestStreamKey,
  stream: StreamRefresh,
  logStartsAt: string | null,
  now: Date = new Date(),
): RefreshCopy {
  const label = STREAM_LABELS[key];
  const attention = NEEDS_ATTENTION.includes(stream.delivery);
  const checkedAgo = ago(stream.lastChecked, now);
  const storedRowsAgo = ago(stream.lastStoredRows, now);

  if (stream.delivery === 'not_logged') {
    // Says the log cannot answer — NOT that the pipeline never ran. The two are
    // different claims and only one of them is supported.
    const from = parseLogStamp(logStartsAt);
    return {
      label,
      refreshed: 'Not recorded',
      checked: from
        ? `No pass logged for this country. The ingest log starts ${from.toISOString().slice(0, 10)}.`
        : 'No pass logged for this country.',
      attention: false,
    };
  }

  if (stream.delivery === 'never_delivered') {
    return {
      label,
      refreshed: 'Never',
      checked: checkedAgo
        ? `Checked ${checkedAgo}. No pass has ever stored a row for this country.`
        : 'No pass has ever stored a row for this country.',
      attention,
    };
  }

  if (stream.delivery === 'checked_no_data') {
    return {
      label,
      refreshed: storedRowsAgo ?? 'Never',
      checked: checkedAgo
        ? `Checked ${checkedAgo} — that pass stored nothing.`
        : 'The most recent pass stored nothing.',
      attention,
    };
  }

  return {
    label,
    refreshed: storedRowsAgo ?? 'Never',
    checked: checkedAgo ? `Checked ${checkedAgo}.` : 'Checked.',
    attention,
  };
}

/** Every stream's copy, in display order. */
export function describeAllRefreshes(
  ingest: IngestFreshness,
  now: Date = new Date(),
): RefreshCopy[] {
  return REFRESH_STREAM_ORDER.map((key) =>
    describeRefresh(key, ingest[key], ingest.logStartsAt, now),
  );
}

/**
 * The caption above the list, carrying the two things the timestamps below
 * cannot say for themselves.
 *
 * First, the source: "last refreshed" is otherwise ambiguous between "the
 * producer published" and "we fetched", and only the second is knowable here.
 *
 * Second, and more important, the limit. A pass "storing rows" includes
 * rewriting rows we already held, so these times do NOT establish that the
 * series advanced — see this module's header for AL load, frozen since
 * 2026-08-06 while still storing hundreds of rows a day. The freshness pill
 * this panel opens from is the thing that reads `MAX(timestamp_utc)` and can
 * answer how old the data is, so the caption points there rather than letting
 * a reader draw the stronger conclusion on their own.
 */
export const REFRESH_PANEL_CAPTION =
  'When our ingest last ran for this country and last stored rows. Not an upstream publication time — ENTSO-E stamps its documents when we request them. A pass can re-store rows we already had, so this does not by itself mean the data got newer; the badge above reports how old the data is.';
