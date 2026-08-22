/**
 * What a change-log entry is, and the rules an entry has to satisfy to be
 * published at all.
 *
 * ABL-532. The subscriber terms (§9.3, §9.3.1, §9.3.2 — ABL-297 Draft 0.5 rev 6)
 * commit us to two different publication behaviours through one channel, and the
 * whole design of this module is the observation that **an entry carrying one
 * date makes one of them a lie**:
 *
 * - a *material* model change is published **30 days before** it takes effect;
 * - a change that corrects values which are **wrong** may be served immediately,
 *   with its entry published **at the same time as the change**, stating that it
 *   was a correction and what was wrong.
 *
 * So an entry carries two times and a type, and the type is enforced against the
 * two times rather than being a label somebody picks.
 *
 * ## Why instants rather than dates
 *
 * "Thirty days' advance notice" is a **duration** and "at the same time as the
 * change" is a claim about an **instant**. A `DATE` column can express neither
 * without a convention nobody wrote down — is a correction published at 23:50
 * and served at 00:10 the next day "the same time"? — and the convention is
 * exactly the thing a subscriber would be entitled to argue about. Both fields
 * are therefore ISO-8601 instants normalised to UTC, and the rendered page shows
 * both plus the interval between them so the notice is a number a reader can
 * check rather than a claim they have to accept.
 *
 * ## What is deliberately *not* here
 *
 * No clock. Everything in this module is a pure function of the entry, which is
 * what lets the page and the JSON be rendered deterministically and asserted
 * byte-for-byte. The one place `now` enters is the store, which stamps
 * `publishedAt` at insert (`sqliteChangelogStore.ts`) — and it stamps it rather
 * than accepting it, so a thirty-day notice cannot be manufactured after the
 * fact.
 */

/**
 * The entry types, in the order they are listed to a reader.
 *
 * Two, which is the minimum the Terms make distinguishable and the maximum this
 * issue's scope allows. §9.3 also names two further notice obligations — six
 * months before a major version is retired, and "as much notice as we lawfully
 * can" before a dataset is withdrawn — and each will eventually want its own
 * type with its own interval rule. They are absent because nothing serves them
 * yet, and a type nobody publishes is a rule nobody maintains. Adding one is a
 * new member here plus a new branch in {@link problemsWithEntry}; the exhaustive
 * `switch` there is what makes the compiler point at the branch.
 */
export const CHANGELOG_ENTRY_TYPES = ['planned', 'correction'] as const;

export type ChangelogEntryType = (typeof CHANGELOG_ENTRY_TYPES)[number];

/** The advance notice a planned material change is published with. */
export const NOTICE_PERIOD_DAYS = 30;

export const NOTICE_PERIOD_MS = NOTICE_PERIOD_DAYS * 86_400_000;

/**
 * How far ahead of its effective instant a **correction** may be published.
 *
 * Not zero, and the hour is operational rather than legal. The safe order for an
 * operator is *publish the notice, then flip the switch* — that way the entry is
 * never missing while the corrected values are already being served. Requiring
 * `published >= effective` would push operators into the opposite, riskier
 * order to satisfy a validator.
 *
 * What the bound actually prevents is the loophole: a change whose effective
 * instant is days away is a **planned** change wearing a correction's label to
 * escape the thirty days. An hour is far too short to be useful for that and far
 * more than enough for the operational case.
 *
 * Note the asymmetry — publishing a correction *late* is not refused here. See
 * {@link correctionPublicationLagMs}.
 */
export const CORRECTION_MAX_LEAD_MS = 3_600_000;

/** A published entry, as stored and as rendered. */
export interface ChangelogEntry {
  /** Stable, opaque, and the fragment identifier of the entry on the page. */
  id: string;
  type: ChangelogEntryType;
  /** When this entry went up. Stamped by the store, never supplied. */
  publishedAt: string;
  /** When the change takes, or took, effect in the data we serve. */
  effectiveAt: string;
  title: string;
  /** Prose: what changed. */
  detail: string;
  /** Required on a correction, refused on anything else. */
  whatWasWrong: string | null;
  /** Marks an entry that describes no real change. Rendered loudly. */
  isExample: boolean;
}

/** What an operator supplies. Note the absence of `id` and `publishedAt`. */
export interface ChangelogEntryDraft {
  type: ChangelogEntryType;
  effectiveAt: string;
  title: string;
  detail: string;
  whatWasWrong?: string | null;
  isExample?: boolean;
}

/** Thrown by {@link assertPublishable} and by the instant parser. */
export class ChangelogEntryError extends Error {}

/**
 * The one shape an instant is stored in: UTC, milliseconds, `Z`.
 *
 * Pinned as a regex rather than trusted from `Date.prototype.toISOString`
 * because the string comparison in {@link sortEntriesNewestFirst} is only a
 * chronological comparison while every stored instant has the same width and the
 * same zone. A row inserted by hand as `2026-08-22T14:00+02:00` would sort
 * plausibly and wrongly.
 */
const STORED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * What an operator may type, before normalisation.
 *
 * **A zone is mandatory.** `2026-09-21T14:00` is refused rather than read as
 * local time: the effective instant of a change is the thing the notice period
 * is measured against, and resolving it against whichever timezone the operator's
 * laptop happened to be in is how a thirty-day notice quietly becomes
 * twenty-nine days and twenty-two hours. Seconds and milliseconds are optional.
 */
const ACCEPTED_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Whether `YYYY-MM-DD` names a day that exists.
 *
 * Needed because `new Date('2026-02-30T09:00:00Z')` does **not** produce an
 * invalid date in V8 — it rolls the day over and returns 2 March. Checked rather
 * than assumed (2026-08-22): an operator who mistypes a month length would
 * otherwise get a silently shifted effective instant, on the one field the
 * notice period is measured against.
 */
function isRealCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= lengths[month - 1];
}

/**
 * Normalise an operator-supplied instant to the stored shape, or refuse it.
 *
 * `label` names the flag in the error, because this is reached from a CLI and
 * "invalid date" without saying which one is the least useful message a tool can
 * print.
 */
export function parseInstant(value: string, label: string): string {
  const trimmed = value.trim();
  if (!ACCEPTED_INSTANT.test(trimmed)) {
    throw new ChangelogEntryError(
      `${label} must be an ISO-8601 instant with an explicit time zone, for example ` +
        `2026-09-21T09:00:00Z or 2026-09-21T11:00:00+02:00. Got "${value}". A time with no ` +
        'zone is refused rather than read as local time: it is the instant the notice period ' +
        'is measured against.'
    );
  }

  const [year, month, day] = trimmed.slice(0, 10).split('-').map(Number);
  const parsed = new Date(trimmed);
  if (!isRealCalendarDay(year, month, day) || Number.isNaN(parsed.getTime())) {
    throw new ChangelogEntryError(
      `${label} is not a real instant: "${value}". A date that does not exist is refused ` +
        'rather than rolled over into the next month.'
    );
  }
  return parsed.toISOString();
}

/** Milliseconds between publication and effect. Positive means notice was given. */
export function noticeIntervalMs(entry: ChangelogEntry): number {
  return Date.parse(entry.effectiveAt) - Date.parse(entry.publishedAt);
}

/**
 * How late a correction's entry was, in milliseconds; `0` if it was not late.
 *
 * Separate from {@link noticeIntervalMs} because lateness is the one property
 * this module reports and does not refuse. Nothing in a validator can stop an
 * operator publishing an hour after the swap, and refusing the entry at that
 * point would trade *a late notice* for *no notice*, which is strictly worse for
 * the subscriber it exists to serve. The CLI warns; the page shows both instants;
 * neither pretends it did not happen.
 */
export function correctionPublicationLagMs(entry: ChangelogEntry): number {
  return Math.max(0, -noticeIntervalMs(entry));
}

/**
 * A duration in words: at most two units, largest first, no locale.
 *
 * Hand-rolled for the reason the rest of this surface is (`publicAppGraph.test.ts`
 * treats a new package here as a decision): a date library would arrive to format
 * "30 days".
 */
export function formatInterval(ms: number): string {
  const totalMinutes = Math.round(Math.abs(ms) / 60_000);
  if (totalMinutes === 0) return 'less than a minute';

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  const push = (n: number, unit: string) => {
    if (n > 0) parts.push(`${n} ${unit}${n === 1 ? '' : 's'}`);
  };
  push(days, 'day');
  push(hours, 'hour');
  if (days === 0) push(minutes, 'minute');

  return parts.slice(0, 2).join(' ');
}

/**
 * How close two instants have to be before the page calls them the same time.
 *
 * "Published at the same time as the change" cannot mean *the same millisecond*:
 * the change is served when an operator promotes an artifact and the entry is
 * stamped when they run the publish command, and no amount of care collapses
 * those into one instant. A minute is the granularity at which the claim is both
 * honest and checkable — and nothing is hidden by it, because the page prints
 * both instants next to the phrase.
 */
export const SAME_TIME_TOLERANCE_MS = 60_000;

/**
 * The notice, as one factual phrase, computed from the entry and nothing else.
 *
 * Deliberately clock-free and tense-free. "Takes effect in 4 days" would need a
 * `now`, would change between two loads of the same page, and would make every
 * assertion about the rendered document a moving target. What a reader needs is
 * the interval that was actually given, which is a property of the entry.
 */
export function describeNotice(entry: ChangelogEntry): string {
  const interval = noticeIntervalMs(entry);
  if (Math.abs(interval) <= SAME_TIME_TOLERANCE_MS) {
    return 'published at the same time as the change';
  }
  if (interval > 0) return `${formatInterval(interval)} before the change takes effect`;
  return `${formatInterval(interval)} after the change took effect`;
}

function blank(value: string | null | undefined): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * Every reason this entry may not be published, as operator-facing sentences.
 *
 * Returning the list rather than throwing on the first problem is deliberate:
 * an operator publishing a correction at the moment a correction is being served
 * should be told everything wrong with the command in one go, not made to run it
 * four times.
 */
export function problemsWithEntry(entry: ChangelogEntry): string[] {
  const problems: string[] = [];

  if (!(CHANGELOG_ENTRY_TYPES as readonly string[]).includes(entry.type)) {
    // Nothing below can be checked meaningfully without a known type, and every
    // remaining rule is keyed on it.
    return [`type must be one of: ${CHANGELOG_ENTRY_TYPES.join(', ')}. Got "${entry.type}".`];
  }
  if (blank(entry.id)) problems.push('id is required.');
  if (blank(entry.title)) problems.push('title is required — it is the heading a reader scans.');
  if (blank(entry.detail)) {
    problems.push('detail is required — an entry that does not say what changed is not a notice.');
  }
  let instantsUsable = true;
  for (const [field, value] of [
    ['publishedAt', entry.publishedAt],
    ['effectiveAt', entry.effectiveAt],
  ] as const) {
    if (!STORED_INSTANT.test(value ?? '')) {
      problems.push(`${field} must be a UTC instant of the form 2026-09-21T09:00:00.000Z.`);
      instantsUsable = false;
    }
  }
  // Every rule below is arithmetic on the two instants, so an unparseable one
  // would turn into a NaN comparison and a second, misleading complaint about
  // the notice period. Stop at the real problem.
  if (!instantsUsable) return problems;

  const interval = noticeIntervalMs(entry);

  switch (entry.type) {
    case 'planned': {
      if (interval < NOTICE_PERIOD_MS) {
        problems.push(
          `a planned change needs ${NOTICE_PERIOD_DAYS} days' notice: effectiveAt must be at ` +
            `least ${NOTICE_PERIOD_DAYS} days after publication, and this entry gives ` +
            `${
              interval < 0
                ? 'none — its effective instant is before publication'
                : formatInterval(interval)
            }. Publication is stamped at insert and cannot be ` +
            'backdated, so the fix is a later effective instant — or, if the change is ' +
            'correcting values that are wrong, the correction type.'
        );
      }
      if (!blank(entry.whatWasWrong)) {
        problems.push(
          'whatWasWrong belongs only on a correction. A planned change is an improvement we ' +
            'are giving notice of, not a defect we are admitting; carrying the field here would ' +
            'make the two indistinguishable to a reader filtering on it.'
        );
      }
      break;
    }
    case 'correction': {
      if (interval > CORRECTION_MAX_LEAD_MS) {
        problems.push(
          `a correction is served immediately and published at the same time, so effectiveAt ` +
            `may be at most ${formatInterval(CORRECTION_MAX_LEAD_MS)} after publication. This ` +
            `entry puts it ${formatInterval(interval)} ahead, which is a planned change — ` +
            `publish it as one, with ${NOTICE_PERIOD_DAYS} days' notice.`
        );
      }
      if (blank(entry.whatWasWrong)) {
        problems.push(
          'whatWasWrong is required on a correction: the entry has to say what was wrong, not ' +
            'only that something was fixed.'
        );
      }
      break;
    }
  }

  return problems;
}

/** {@link problemsWithEntry}, as a refusal. */
export function assertPublishable(entry: ChangelogEntry): void {
  const problems = problemsWithEntry(entry);
  if (problems.length === 0) return;
  throw new ChangelogEntryError(
    `This entry cannot be published:\n${problems.map((p) => `  - ${p}`).join('\n')}`
  );
}

/**
 * Newest first, by **publication** — not by effective instant.
 *
 * A change log is a notice feed: the top of the page is the most recent thing we
 * said. Ordering by effective instant would float a change that takes effect in
 * thirty days above a correction published a week later, which reads as a
 * chronology and is not one; it would also make an entry *move* as later entries
 * arrive, and a published record that reorders itself is not much of a record.
 *
 * The comparison is on the strings, which is chronological because every stored
 * instant is UTC with the same width ({@link STORED_INSTANT}). The id tie-break
 * only matters for rows that were not inserted through this codebase — the store
 * gives publication a total order — but it is here so that "newest first" is
 * deterministic for *any* input rather than only for well-formed input.
 */
export function sortEntriesNewestFirst(entries: readonly ChangelogEntry[]): ChangelogEntry[] {
  return [...entries].sort((a, b) => {
    if (a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? 1 : -1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? 1 : -1;
  });
}

/** One entry as it appears in `/changelog.json`. Snake_case, like the rest of the surface. */
export interface WireChangelogEntry {
  id: string;
  type: ChangelogEntryType;
  published_at: string;
  effective_at: string;
  notice_seconds: number;
  notice: string;
  title: string;
  detail: string;
  what_was_wrong: string | null;
  example: boolean;
}

export function toWireEntry(entry: ChangelogEntry): WireChangelogEntry {
  return {
    id: entry.id,
    type: entry.type,
    published_at: entry.publishedAt,
    effective_at: entry.effectiveAt,
    // The interval as a number as well as a phrase, so a subscriber watching for
    // notices can assert on it instead of parsing English.
    notice_seconds: Math.round(noticeIntervalMs(entry) / 1000),
    notice: describeNotice(entry),
    title: entry.title,
    detail: entry.detail,
    what_was_wrong: entry.whatWasWrong,
    example: entry.isExample,
  };
}

/** The whole document `/changelog.json` serves. */
export interface WireChangelog {
  notice_period_days: number;
  entries: WireChangelogEntry[];
}

export function toWireChangelog(entries: readonly ChangelogEntry[]): WireChangelog {
  return {
    // Stated as data so a subscriber's watcher can check our arithmetic rather
    // than hard-coding 30 from prose it read once.
    notice_period_days: NOTICE_PERIOD_DAYS,
    entries: sortEntriesNewestFirst(entries).map(toWireEntry),
  };
}
