<!--
No existing PR carried this checklist (ABL-728): three PRs in a row (#79, #80,
#81) added tests without raising TEST_FLOORS, even though CLAUDE.md > Testing
already states the rule in prose. Prose that only lives in CLAUDE.md is easy to
not re-read at PR time; this file is what GitHub puts in front of you instead.
-->

## Checklist

- [ ] `cd client && npx vitest run && npx tsc -b` and `cd server && npx vitest run` are clean.
- [ ] **If this PR adds or removes tests**, `TEST_FLOORS` in `scripts/testFloor.mjs` is raised
      in this same commit (or, for a drop, the commit message says which tests left and why).
      `scripts/testFloor.mjs` only catches a collection regression if it tracks the tree.
- [ ] If this PR changes `partialize` or the persisted store shape, `PERSIST_VERSION` is bumped
      and `migratePersisted()` has a new clause.
- [ ] Any CLAUDE.md claim this PR invalidates is corrected in the same commit.
