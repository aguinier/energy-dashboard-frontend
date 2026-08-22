import { NOTICE_PERIOD_MS, type ChangelogEntryDraft } from './changelogEntry.js';

/**
 * One entry of each type, describing no real change.
 *
 * They exist so that both halves of the two-date model are exercised end to end —
 * a `planned` entry whose effective instant is thirty days out, and a
 * `correction` whose entry is published at the same instant the change was
 * served — rather than only in a unit test. `npm run changelog -- entries:seed
 * --examples` installs them.
 *
 * ## Why they are computed rather than constant
 *
 * The store stamps `published_at` at insert and refuses to take one
 * (`sqliteChangelogStore.ts`), which is what stops a thirty-day notice being
 * manufactured after the fact. So a constant pair of dates would be refused the
 * moment it aged: a fixed effective date thirty days after some day in 2026 stops
 * satisfying the rule the day after it is written. Deriving the effective instant
 * from the publication instant means the examples are valid whenever they are
 * seeded, and it demonstrates the arithmetic an operator will actually do.
 *
 * ## The flag they carry
 *
 * `isExample` renders as a loud line above the entry saying it describes no real
 * change. That is not decoration: this page is the one a subscriber is
 * contractually pointed at, and an example entry that reads as a real notice
 * would be worse than no example at all. `entries:seed` also requires an explicit
 * `--examples`, so nothing seeds them by accident.
 */
export function buildExampleEntries(publishedAt: Date): ChangelogEntryDraft[] {
  const effective = (offsetMs: number) => new Date(publishedAt.getTime() + offsetMs).toISOString();

  return [
    {
      type: 'planned',
      // Exactly the notice period. The store's publication instant may be nudged
      // a millisecond forward to keep publication totally ordered, so a little
      // headroom keeps the example from failing its own rule by one tick.
      effectiveAt: effective(NOTICE_PERIOD_MS + 60_000),
      title: 'Example: a planned change to a forecast model',
      detail:
        'This is what a planned change looks like. It names the countries, datasets and ' +
        'forecast types affected, says what is changing about the model that produces them, ' +
        'and gives the instant the new values start being served. Requests made before that ' +
        'instant are unaffected; requests made after it return values from the new model. The ' +
        'response schema does not change.',
      isExample: true,
    },
    {
      type: 'correction',
      // The same instant as publication: served immediately, published at the
      // same time.
      effectiveAt: effective(0),
      title: 'Example: a correction to values that were wrong',
      detail:
        'This is what a correction looks like. It is served as soon as it is ready rather ' +
        'than after a notice period, because leaving wrong values in place for another month ' +
        'would not be a service to anyone reading them. The entry goes up at the same time as ' +
        'the change, names what is affected, and states the instant from which the corrected ' +
        'values are served.',
      whatWasWrong:
        'A correction entry has to say what was wrong, not only that something was fixed: ' +
        'which values were affected, over what period, and in which direction they were wrong, ' +
        'so a reader can tell whether anything they built on those values needs revisiting.',
      isExample: true,
    },
  ];
}
