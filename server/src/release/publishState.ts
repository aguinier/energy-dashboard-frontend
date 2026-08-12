/**
 * Is local `main` itself published?
 *
 * `unmergedWork.ts` answers "did the branch reach the target?" — and it is
 * right. What it cannot answer is the case that produced ABL-79, ABL-98,
 * ABL-136, ABL-189/190/196, ABL-262/265 and ABL-311: the branch *was* merged,
 * into local `main`, and local `main` was never pushed.
 *
 * That case slips through for a precise reason. `classifyBranch()` reads an
 * issue identifier out of the branch name, and `main` has none, so
 * `issueFromBranch('main')` returns null and the verdict is `unattributed` —
 * "reported, not failed" (`unmergedWork.ts`, the Verdict union). So a `main`
 * sitting twelve commits ahead of `origin/main` prints one grey line and the
 * check exits 0. On 2026-08-12 that was five issues' entire day of work.
 *
 * The branch-level check also depends on the branch still existing. Delete the
 * feature branch after merging, or commit straight to `main`, and there is no
 * tip left to classify at all.
 *
 * So this is a second, independent gate over the one ref that always exists and
 * never carries an issue name. It is deliberately **board-independent**: it asks
 * git a question git can always answer, which matters because the board half
 * returns 0 when `PAPERCLIP_API_URL`/`_API_KEY`/`_COMPANY_ID` are absent. A gate
 * that needs a reachable network to fail is a gate that fails open.
 *
 * Pure, as `unmergedWork.ts` is: the caller supplies the two counts, so the
 * classification is unit-testable without a repo or a remote.
 */

/**
 * Counts from `git rev-list --left-right --count <target>...main`, which is one
 * command and cannot disagree with itself the way two separate counts can.
 */
export interface PublishCounts {
  /** Commits on local `main` that are not on the target ref. */
  ahead: number;
  /** Commits on the target ref that are not on local `main`. */
  behind: number;
}

export type PublishVerdict =
  /** Nothing on local `main` is missing from the target. The clean state. */
  | 'published'
  /** Target has commits local `main` lacks, but nothing local is stranded. */
  | 'behind'
  /** Local `main` has commits the target lacks. The ABL-311 defect. */
  | 'unpublished'
  /** Stranded commits *and* unpulled ones. Unpublished, plus a merge to do. */
  | 'diverged'
  /** No local `main` in this checkout, so there is nothing here to strand. */
  | 'no-local-main';

/**
 * The verdicts that must fail the check.
 *
 * Only the two that mean "work exists locally and is not on the target".
 * `behind` is a normal, healthy state — it is what every checkout looks like
 * between someone else's push and your next fetch — and failing on it would
 * make the gate cry wolf, which is how the last one got ignored.
 */
export function isPublishGap(verdict: PublishVerdict): boolean {
  return verdict === 'unpublished' || verdict === 'diverged';
}

/**
 * Classify the publish state. `counts` is null when local `main` does not
 * resolve.
 *
 * A missing local `main` is reported rather than failed, and that is not a
 * fail-open hole: stranding requires commits sitting on a local `main`, so if
 * there is no local `main` there is by construction nothing stranded here. A
 * detached worktree or a fresh `--single-branch` clone hits this legitimately.
 */
export function classifyPublishState(counts: PublishCounts | null): PublishVerdict {
  if (counts === null) return 'no-local-main';

  const { ahead, behind } = counts;
  if (!Number.isInteger(ahead) || !Number.isInteger(behind) || ahead < 0 || behind < 0) {
    throw new Error(
      `publish counts must be non-negative integers, got ahead=${ahead} behind=${behind}`,
    );
  }

  if (ahead === 0) return behind === 0 ? 'published' : 'behind';
  return behind === 0 ? 'unpublished' : 'diverged';
}

/**
 * Render the verdict for a terminal.
 *
 * The failing messages name the fix as a command, because the whole point is
 * that the last step was known and skipped, not unknown.
 */
export function formatPublishState(
  verdict: PublishVerdict,
  counts: PublishCounts | null,
  target: string,
): string {
  const ahead = counts?.ahead ?? 0;
  const behind = counts?.behind ?? 0;

  switch (verdict) {
    case 'published':
      return `main is published: 0 ahead, 0 behind ${target}.`;
    case 'behind':
      return `main is published: 0 ahead, ${behind} behind ${target} (fast-forward available).`;
    case 'unpublished':
      return (
        `NOT PUBLISHED  main is ${ahead} commit(s) ahead of ${target}. ` +
        `Work merged to local main has not reached the remote — that is the ` +
        `defect, not a formality. Run: git push origin main`
      );
    case 'diverged':
      return (
        `NOT PUBLISHED  main is ${ahead} ahead of and ${behind} behind ${target}. ` +
        `Integrate first, then publish: git pull --ff-only origin main ` +
        `(or merge), then git push origin main`
      );
    case 'no-local-main':
      return `No local 'main' ref in this checkout — nothing to publish from here.`;
  }
}
