import type { ForecastDataPoint } from '@/types';

/**
 * How to describe the *vintage* of the ML forecast a chart is currently
 * drawing: when the run that produced it was generated, and by which model.
 *
 * WHY THIS IS NOT `latestForecast[0]`
 *
 * The component this replaces (`ForecastMetadataBadge`, deleted with ABL-285)
 * read `GET /forecasts/latest`'s row zero and commented that "all points in a
 * batch share the same metadata". Two things were wrong with that:
 *
 * 1. **It described a different batch than the chart drew.** `/forecasts/latest`
 *    pins to `MAX(generated_at)` for the whole country, across every forecast
 *    type and model. Measured on the replica 2026-08-12, that batch was
 *    `wind_onshore` for AT and `biomass` for BE — so a load chart would have
 *    been stamped with a wind run's generation time. The chart's own rows
 *    (`getForecastData`, `forecastService.ts:65-93`) already carry
 *    `generated_at` / `model_name` / `model_version` per point, so the honest
 *    source for "when was *this line* generated" is the line itself.
 * 2. **Row zero does not speak for the batch.** `/forecasts`'s hourly branch
 *    pins each target timestamp to its own `MAX(generated_at)`, so one window
 *    routinely spans several runs — DE `load` had runs at 14:00, 15:30 and
 *    19:00 on 2026-08-11 alone. Naming one generation time for all of them is
 *    the same defect `NetPositionTab` already fixed for net position (see
 *    `netPositionProvenance.ts`): several vintages on screen get counted, not
 *    collapsed into whichever sorted first.
 *
 * `horizon_hours` is deliberately absent from everything below. One run emits
 * 24 points spanning ~28-51h ahead, so `[0].horizon_hours` labels a whole day's
 * block by its first hour. There is no single horizon to report here.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * Two `generated_at` stamps closer together than this are one run, not two.
 *
 * The writers stamp per row, not once per batch: measured against production
 * on 2026-08-12, a single DE `load` window returned 47 points carrying
 * `2026-08-11T19:00:41.756470` and `2026-08-11T19:00:41.919369` — the same
 * scheduled 19:00 batch, 163 *microseconds* apart. Counting raw distinct
 * values would have put "newest of 2 runs" under that chart, which reads as
 * "this line mixes two forecast runs" and is false.
 *
 * A real re-run is minutes or hours apart — the same DE `load` target had
 * genuinely separate runs at 14:00, 15:30 and 19:00 on 2026-08-11. One minute
 * separates the two cases with room to spare, and the cost of being wrong is
 * bounded and stated: runs merged by this rule differ by under a minute, and
 * the age we report is the newest of them.
 */
const RUN_GAP_MS = 60_000;

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * `YYYY-MM-DD`, then `T` or a space, then the clock — with optional seconds,
 * optional fractional seconds, and an optional zone suffix.
 *
 * Both separators are real: measured on the replica 2026-08-12, `forecasts`
 * holds 2,124,371 `T`-form and 15,432 space-form `generated_at` values, split
 * by which writer produced the row (`catboost`/`xgboost` write `T`, the
 * chronos and challenger runners write a space). Neither form is a defect to
 * normalise away here — see CLAUDE.md's ABL-21 section.
 */
const STORED_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse a stored `generated_at` as the instant it actually is.
 *
 * A bare `2026-08-11T19:00:58.721815` carries no zone, and V8 parses that as
 * **local** time. That is the exact defect CLAUDE.md records against the header
 * freshness pill: it "understated the age by the viewer's UTC offset — two
 * hours in Brussels, always in the reassuring direction". A forecast-age badge
 * would have reproduced it verbatim.
 *
 * A bare value is UTC. Every model registered in `forecastModels.ts` writes it
 * that way — `energy-forecast/src/db.py:819` and `scripts/forecast_chronos2.py:141`
 * use `datetime.utcnow()`, `scripts/forecast_challengers.py:341` uses
 * `datetime.now(timezone.utc)`. The one writer that does not is
 * `src/chronos_forecaster.py:352` (`datetime.now()`, host-local), and its model
 * `chronos-bolt-small` is deliberately unregistered and last wrote 2026-03-03,
 * so it can never reach a chart. If that model is ever registered, this
 * assumption needs re-checking before it is.
 *
 * An explicit zone, if one ever appears, is honoured rather than overridden.
 * Returns `null` for anything unparseable — including a date that does not
 * exist, which `Date.UTC` would otherwise roll forward into a real one.
 */
export function parseGeneratedAt(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const m = STORED_TIMESTAMP.exec(raw.trim());
  if (!m) return null;

  const [, year, month, day, hour, minute, second, fraction, zone] = m;
  const ms = fraction ? Number(fraction.slice(0, 3).padEnd(3, '0')) : 0;

  if (zone) {
    const t = new Date(
      `${year}-${month}-${day}T${hour}:${minute}:${second ?? '00'}.${String(ms).padStart(3, '0')}${zone}`,
    );
    return Number.isNaN(t.getTime()) ? null : t;
  }

  const d = new Date(
    Date.UTC(+year, +month - 1, +day, +hour, +minute, second ? +second : 0, ms),
  );
  // `Date.UTC(2026, 1, 30)` silently becomes 2 March. Reject rather than
  // report a generation time the run cannot have had.
  if (
    d.getUTCFullYear() !== +year ||
    d.getUTCMonth() !== +month - 1 ||
    d.getUTCDate() !== +day ||
    d.getUTCHours() !== +hour ||
    d.getUTCMinutes() !== +minute
  ) {
    return null;
  }
  return d;
}

/** `2026-08-11T19:00:58.721815` -> `11 Aug 19:00 UTC`. */
function formatUtcShort(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm} UTC`;
}

/** `2026-08-11T19:00:58.721815` -> `2026-08-11 19:00:58 UTC`. */
function formatUtcFull(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
  );
}

/** Coarse, honest age. Never rounds a two-day-old run down to "yesterday". */
function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return '<1m ago';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(ageMs / HOUR_MS);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface ForecastVintage {
  /** Newest stamp among the drawn points, as stored. */
  newestGeneratedAt: string;
  /**
   * Oldest stamp among the drawn points, as stored. This can differ from
   * `newestGeneratedAt` while `runCount` is still 1 — one batch stamps its rows
   * microseconds apart, and `RUN_GAP_MS` folds those back into one run.
   */
  oldestGeneratedAt: string;
  /** Runs among the drawn points, clustered by `RUN_GAP_MS`. Never 0. */
  runCount: number;
  /**
   * Whole hours since the newest run, or `null` when no age can be stated —
   * a run stamped in the future (clock skew between the model host and the
   * viewer) gets no relative claim at all, only the absolute stamp.
   */
  ageHours: number | null;
  /** Distinct `model_name`s, sorted. Empty when the rows name none. */
  models: string[];
  /** Distinct `model_version`s, sorted. Empty when the rows name none. */
  versions: string[];
  /** One line, for under the chart. */
  summary: string;
  /** Longer form, for `title=`. */
  detail: string;
}

/**
 * Which models produced the drawn points, in one phrase.
 *
 * One `/forecasts` response carries exactly one `model_name`, pinned or not:
 * `getForecastData` returns the first candidate in the ladder that has rows
 * (`forecastService.ts:32-37`) and `queryForecasts` always filters
 * `AND model_name = ?` (`:51`). So the multi-name branch below is a guard, not
 * a live case — it exists so that widening the read (or feeding this a merged
 * set) degrades to naming every model rather than silently labelling the lot
 * from whichever row sorted first, which is the defect ABL-285 was filed on.
 *
 * The two branches that *are* live: the aggregated (daily/weekly) branch
 * selects no `model_name`/`model_version` at all (`forecastService.ts:96-110`),
 * and `model_version` is never pinned, so one window's per-timestamp
 * `MAX(generated_at)` can straddle a retrain and return several versions.
 */
function describeModels(models: string[], versions: string[]): string | null {
  if (models.length === 0) return null;
  if (models.length > 1) return models.join(', ');
  if (versions.length === 1) return `${models[0]} ${versions[0]}`;
  if (versions.length > 1) return `${models[0]} · ${versions.length} versions`;
  return models[0];
}

function sortedDistinct(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((v): v is string => !!v))].sort();
}

/** Bucket a timestamp to its hour, the way `buildSeriesGrid` bins chart points. */
function hourKey(ts: string): number {
  return Math.floor(new Date(ts).getTime() / HOUR_MS) * HOUR_MS;
}

/**
 * Describe the vintage of the forecast points a chart is drawing.
 *
 * `window` must be the same clip the chart applies (`buildSeriesGrid`'s
 * `window`), because the fetch is deliberately wider than the canvas: the
 * "Today" preset fetches to `now + 48h` but draws only today. Without the clip
 * this would report the newest run in the *response*, which on that preset is
 * a run whose points are entirely off-screen — a fresher generation time than
 * anything the reader can see.
 *
 * Returns `null` when there is nothing to describe: no points, no points left
 * inside the window, no point the chart would actually paint, or no parseable
 * `generated_at` among them. A chart with no forecast line gets no vintage line
 * under it.
 */
export function describeForecastVintage(
  points: ForecastDataPoint[] | undefined,
  opts: { now?: Date; window?: { start: Date; end: Date } } = {},
): ForecastVintage | null {
  if (!points || points.length === 0) return null;

  const { window } = opts;
  const now = opts.now ?? new Date();

  const from = window ? hourKey(window.start.toISOString()) : -Infinity;
  const to = window ? hourKey(window.end.toISOString()) : Infinity;

  // Both conditions mirror `buildSeriesGrid` exactly: it drops a forecast point
  // whose hour falls outside the grid (`chartAdapters.ts:91`) and paints one
  // only when its value is finite (`:92`). `ForecastDataPoint.value` is typed
  // `number`, but it is a raw SQLite column and that guard is there because the
  // column can hand back a non-number. Describing a run whose points are all
  // clipped or all unpaintable would stamp a generation time under a chart with
  // no forecast line on it.
  const drawn = points.filter((p) => {
    if (!p.timestamp) return false;
    const t = hourKey(p.timestamp);
    return Number.isFinite(t) && Number.isFinite(p.value) && t >= from && t <= to;
  });
  if (drawn.length === 0) return null;

  // Ordered by parsed instant, never by string. `'T' > ' '` as a string, so a
  // space-form run generated after a `T`-form one would lose a lexical
  // comparison outright — the same separator hazard ABL-21 documents for range
  // predicates, and both separators really do occur in this column.
  const runs = new Map<string, Date>();
  for (const p of drawn) {
    if (runs.has(p.generated_at)) continue;
    const parsed = parseGeneratedAt(p.generated_at);
    if (parsed) runs.set(p.generated_at, parsed);
  }
  if (runs.size === 0) return null;

  const ordered = [...runs.entries()].sort((a, b) => a[1].getTime() - b[1].getTime());
  const [oldestRaw, oldestAt] = ordered[0];
  const [newestRaw, newestAt] = ordered[ordered.length - 1];

  // Cluster on the gap between consecutive stamps rather than bucketing each to
  // a fixed minute — bucketing would split a batch that happens to straddle a
  // minute boundary, which is the same false "2 runs" by another route.
  let runCount = 1;
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i][1].getTime() - ordered[i - 1][1].getTime() > RUN_GAP_MS) runCount++;
  }

  const models = sortedDistinct(drawn.map((p) => p.model_name));
  const versions = sortedDistinct(drawn.map((p) => p.model_version));

  const ageMs = now.getTime() - newestAt.getTime();
  const ageHours = ageMs < 0 ? null : Math.floor(ageMs / HOUR_MS);

  const shortStamp = formatUtcShort(newestAt);
  const when = ageMs < 0 ? `generated ${shortStamp}` : `generated ${formatAge(ageMs)} (${shortStamp})`;
  const runPhrase = runCount === 1 ? when : `newest of ${runCount} runs ${when}`;

  const modelPhrase = describeModels(models, versions);
  const summary = modelPhrase ? `${modelPhrase} · ${runPhrase}` : runPhrase;

  const detailParts: string[] = [];
  if (modelPhrase) detailParts.push(modelPhrase);
  detailParts.push(
    runCount === 1
      ? `one forecast run on screen, generated ${formatUtcFull(newestAt)}`
      : `${runCount} forecast runs on screen; newest generated ${formatUtcFull(newestAt)}, ` +
        `oldest ${formatUtcFull(oldestAt)}`,
  );

  return {
    newestGeneratedAt: newestRaw,
    oldestGeneratedAt: oldestRaw,
    runCount,
    ageHours,
    models,
    versions,
    summary,
    detail: `${detailParts.join(' — ')}.`,
  };
}
