import type { ChangelogEntry, ChangelogEntryDraft } from './changelogEntry.js';

/**
 * The two capabilities over published entries, split at the type the way
 * ABL-300 split the key store — and for the same reason, applied to a different
 * risk.
 *
 * On the key store the split keeps the serving process from *altering a
 * credential*. Here it keeps the serving process from **altering a published
 * notice**: an entry is a statement we made to a subscriber at a time we
 * recorded, and the process answering public requests should not be able to
 * change one even by mistake. `publicIndex.ts` holds a {@link ChangelogReader};
 * only `changelogCli.ts` ever holds a {@link ChangelogAdminStore}, and the
 * handles underneath them are readonly and read-write respectively — an
 * operating-system property, not a check that returned false.
 *
 * ## What the admin store deliberately cannot do
 *
 * There is **no update and no delete**. Not an oversight, and not laziness about
 * a CRUD surface: a change log is an append-only record of what we said and
 * when. Editing an entry silently rewrites history on the one page a subscriber
 * is contractually pointed at, and deleting one removes the evidence that notice
 * was given. If a published entry is wrong, the answer is another entry — which
 * is precisely the mechanism §9.3.2 already describes for wrong values.
 */
export interface ChangelogReader {
  /** Every published entry, newest first. */
  list(): ChangelogEntry[];
  close(): void;
}

export interface ChangelogAdminStore extends ChangelogReader {
  /**
   * Append an entry, stamping its publication instant and its id.
   *
   * Refuses anything {@link import('./changelogEntry.js').assertPublishable}
   * refuses — so a planned change with less than thirty days' notice, or a
   * correction dated into the future, is not storable rather than merely
   * discouraged.
   */
  publish(draft: ChangelogEntryDraft): ChangelogEntry;
}
