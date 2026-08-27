> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# Testing

## Testing

```bash
cd client && npx vitest run && npx tsc -b
cd server && npx vitest run
```

Green as of 2026-08-22, measured on ABL-528 after merging `origin/main` at
`f5ec75c` (PR #46, ABL-530's auth-failure record) into it, in a per-issue
execution worktree with `node_modules` junctioned from the primary checkout,
under **v24.18.0**, with the shared replica reachable so
`generationService.test.ts`'s opportunistic block is included:

| suite | files | tests | typecheck |
|---|---:|---:|---|
| `cd server && npx vitest run` | **119** | **2,444** | `tsc --noEmit` exit 0 |
| `cd client && npx vitest run` | **54** | **747** | `tsc -b --force` exit 0 |

Both rows are fresh runs on the merged tree. The client row is unchanged from
the entries below and was re-measured anyway rather than carried forward —
neither ABL-528 nor ABL-530 touches a client file, so it is the row most likely
to be asserted from memory and least likely to be checked.

**State the delta beside the absolute, because only one of them keeps.** ABL-528
is **+1 server file / +50 server cases against `origin/main@f5ec75c`**, and that
sentence survives the next merge, when 119 / 2,444 will not. The absolute stays
because it is the tripwire this section exists to be — "fewer than that means
something broke" is not a claim a delta can make — but it is the half with a
shelf life, and this entry has now had that shelf life expire **three times**
before reaching `main`. Read the delta first; re-measure the absolute.

That the delta is the durable half is not a hunch here — it is measured. The
same **+1 / +50** held against all three bases this branch has been rebased
onto (`01e3160`, `08b9cb6`, `9fd4bdb`, `f5ec75c`) while the absolute moved
108 → 113 → 115 → 119 without a line of ABL-528 changing.

**The delta is measured, not derived, and the split is worth keeping.** Running
the same tree with only the new file excluded reports **118 / 2,415**, so
`accountContacts.test.ts` is **29** cases and the edits to existing files are
**21**. Note the 29 is *12* `it(` lines, three of them `it.each` tables — a grep
undercounts any file that uses one, so take a new file's contribution from a run
and only the *edits* from the grep.

**Corroborated two ways.** The file count needs no run: `git ls-tree -r
origin/main --name-only | grep -c '^server/src/.*\.test\.ts$'` returns **117** at
`f5ec75c`, plus the one `scripts/` file the server suite also discovers
(`server/vitest.config.ts:11`) = 118, plus this branch's one new file = **119**,
matching the run. The test count reconciles against the entry below —
`origin/main@f5ec75c` is 118 / 2,394, and 2,394 + 50 = **2,444**.

**This entry was wrong on arrival three times, and every time a merge is why.**
It first recorded **108 / 2,181** against `01e3160`; ABL-532 (PR #47) landed
while ABL-528 sat in review, taking it to **113 / 2,297** against `08b9cb6`;
then ABL-529 (PR #45) landed, taking it to **115 / 2,324** against `9fd4bdb`;
then ABL-530 (PR #46) landed while it sat in review a third time. Not one of
those figures was carelessly taken — all were honest runs — and each described a
tree that had stopped existing by the time anyone could read it. That is the
fifth, sixth and seventh occurrence this section records. Re-measure after
merging the base in, not only after writing the code, and **again if the branch
waits**.

**The fourth merge is the one that stopped being free, and it is the warning
worth keeping.** The first three conflicted on this paragraph alone. Merging
`f5ec75c` conflicted on three files — this one, `usage/PRIVACY-AND-RETENTION.md`
and `usage/sqliteUsageStore.ts` — and, more to the point, **broke 36 tests that
git merged without a single marker.** `security/sqliteAuthFailureStore.test.ts`
mints keys to build its fixture, and ABL-528 refuses a contactless mint, so every
case in the file failed in setup. Both changes were correct; their composition
was not. A conflict-free merge is not a working merge, and the only thing that
said so was a run.

**`tsc --noEmit` could not have caught it, and that is a property of this repo
worth knowing.** `server/tsconfig.json` sets `"exclude": [… "src/**/*.test.ts"]`,
so **test files are never typechecked**. `IssueKeyInput.contactEmail` is a
required `string`, and a call site omitting it still compiled clean, because that
call site was in a test. So "required at the type level" means *production* call
sites here; in a test it is the runtime guard or nothing. That is the argument
for `requireContactEmail` existing at all, arriving from a direction nobody
predicted — see the ABL-528 section above, which now says so.

**A scratch worktree was deliberately not created to measure the baseline.**
That is the standard move, and it is the move that deleted 107 packages out of
the shared tree twice (note 4, ABL-460 and ABL-517) — the removal, not the
install, is the hazard. Excluding one file from a run in the tree you already
have costs one command and cannot walk a junction.

Green as of 2026-08-22, measured on ABL-530 **after merging `origin/main` at
`9fd4bdb`** (which carries ABL-532's change log *and* ABL-529's served-version
guard), in a per-issue execution worktree with `node_modules` junctioned from the
primary checkout, under **v24.18.0**: **118 server test files / 2,394 tests**, all
passing, `tsc --noEmit` exit 0. `origin/main` at that same commit measures
**114 / 2,274**, run in a scratch worktree in the same session rather than taken
from the paragraph below, so ABL-530 is **+4 files / +120 cases**.

Every part of that delta was measured per file, and it adds up exactly, which is
the only reason to write it down:

| | cases |
|---|---:|
| `security/sqliteAuthFailureStore.test.ts` | 36 |
| `security/securityReport.test.ts` | 24 |
| `security/requestTarget.test.ts` | 21 |
| `security/authFailureRecorder.test.ts` | 16 |
| `auth/apiKeyAuth.test.ts` | 34 → 47 |
| `usage/usageCli.test.ts` | 25 → 34 |
| `publicAppGraph.test.ts` | 70 → 71 |
| `publicApp.test.ts` | 48 → 48 |
| | **+120** |

`publicApp.test.ts` being **net zero** is worth a second look rather than a
skim: ABL-530 does add a block there — that a refused request is recorded and
*not* metered — and it replaced cases rather than adding to them. A file whose
count did not move is not a file nobody touched.

It touches no client test, and the client figure below is carried forward rather
than re-measured.

The file count needed no run and is the check to prefer: `git ls-tree -r
origin/main --name-only | grep -c '^server/src/.*\.test\.ts$'` returns 113 at
`9fd4bdb`, plus the one `scripts/` file the server suite also discovers
(`server/vitest.config.ts:11`) = **114**, matching the baseline run; the same
count over this tree's index returns 117 + 1 = **118**, matching the run here.
**Pipe it through `sort -u` if you take it mid-merge** — `git ls-files` lists an
unresolved path once per stage, and an un-deduplicated count read 115 for a tree
holding 114 files while four paths were still conflicted. That duplication is not
only a counting nuisance: `docs/claudeMdCitations.test.ts` resolves a cited path
against the same tracked-file list, so a conflicted file makes every citation into
it fail as `matches 3 files … Cite a longer path`. Stage the resolution before
reading that failure as a stale citation.

**This paragraph was rewritten twice in one sitting, and the second rewrite is
the point.** It first read 111 / 2,252 against `origin/main` at `01e3160`, which
was true when measured and stale by the time it was reviewed: ABL-532 landed as
`08b9cb6` and ABL-529 as `9fd4bdb` while the PR sat. The baseline moved twice
without a line of this branch changing. Re-measure both sides on the merged tree;
never derive one from the other, and never add a delta to a figure recorded under
a different commit.

Green as of 2026-08-22, measured on ABL-529 **after merging `origin/main` at
`08b9cb6`** (which carries ABL-532's change log), in a per-issue execution
worktree with `node_modules` junctioned from the primary checkout, under
**v24.18.0**: **114 server test files / 2,274 tests**, all passing,
`tsc --noEmit` exit 0. ABL-529 is **+2 files / +27 cases**
(`v1/modelVersions/versionGuard.test.ts`,
`v1/modelVersions/servedVersionGate.test.ts`) and touches no client test — its
edits to `publicAppGraph.test.ts` change three pinned module lists without
changing their count, which is checked rather than asserted: that file holds 16
`it(...)` cases on `origin/main` and 16 here.

**The figure is a fresh run on the merged tree, and it had to be.** This entry
read 109 / 2,159 one commit ago, measured honestly against `01e3160` — and
ABL-532 landed underneath it with five new test files, so the same unchanged work
now measures 114. That is the rule this section keeps re-learning: a count is only
true of the tree it was measured on. Do not add 5 to 109.

The delta was measured, not derived: `npx vitest run src/v1/modelVersions/`
reports 2 files / 27 tests on its own. The file count needed no run at all —
`git ls-tree -r origin/main --name-only | grep -c '^server/src/.*\.test\.ts$'`
returns **111**, plus ABL-529's 2 = 113, plus the one `scripts/` file the server
suite also discovers (`server/vitest.config.ts:11`) = **114**, matching the run.
**Deduplicate that count if you take it mid-merge** — `git ls-files` lists an
unresolved path once per stage, and it reported 115 here while
`publicAppGraph.test.ts` was still conflicted.

Green as of 2026-08-21, measured on ABL-493/ABL-501 after merging `origin/main`
at `a508ba1` (the four-branch batch: ABL-460, ABL-494, ABL-498, ABL-469), in a
per-issue execution worktree with `node_modules` junctioned from the primary
checkout, under **v24.18.0**:

| suite | files | tests | typecheck |
|---|---:|---:|---|
| `cd server && npx vitest run` | **107** | **2,132** | `tsc --noEmit` exit 0 |
| `cd client && npx vitest run` | **54** | **747** | `tsc -b --force` exit 0 |

**Both baselines were measured in the same session rather than reconciled from
the entries below**, which is the only way this section has ever been right:
`origin/main` at `a508ba1` was checked out into a scratch worktree and both
suites run against it, giving **server 107 / 2,087** and **client 52 / 704**. So
this branch is **+0 server files / +45 server cases** and **+2 client files /
+43 client cases**. Three of those server cases are *replacements* rather than
additions — see the ABL-469 interaction below — so the delta is not the sum of
what the two issues added.

**The primary checkout's `node_modules` regressed to the ABL-460 state partway
through this run, and the same completeness check found it.** The client suite
ran green here at 13:5x and then failed to boot at 14:2x on
`Cannot find package '@rolldown/pluginutils'` — the bare-specifier tell — with
the note-4 check reporting **107 missing packages** again, `@babel/core` among
them. Nothing in this branch *edited* `node_modules` — but it did delete
through it, which was not obvious at the time and is the whole finding of
ABL-517: the run's own `git worktree remove --force` on a scratch baseline
worktree, at `11:45:58Z`, walked the junction into the shared tree. Note 4
carries the mechanism, the scratch-repo reproduction and the two-line ordering
rule that prevents it. Two things are still worth knowing independently of the
cause: a green suite earlier in your own session is not evidence the tree is
still complete when you re-run it, and **the cheapest repair is often not a
repair at all** — several per-issue worktrees carry their own complete
`node_modules`, so verifying a candidate against your own `package-lock.json`
(0 missing) and repointing your worktree's junction at it costs seconds, writes
nothing shared, and is reversible. Check the candidate against *your* lockfile
rather than assuming: of the two tried here, one was complete and the other was
48 packages short.

The server file count needed no run and confirms the +0: `git ls-tree -r
origin/main --name-only | grep -c '^server/src/.*\.test\.ts$'` returns 106,
plus the one `scripts/` file the suite also discovers
(`server/vitest.config.ts:11`) = 107, and this tree returns the same 106.
**Deduplicate that count during a conflicted merge** — `git ls-files` lists an
unresolved path once per stage, which reported 108 here and would have read as
two phantom new files.

**Merging `origin/main` in broke three tests that git merged cleanly, in a file
neither branch's conflict touched.** ABL-501 stopped exporting `getForecastData`
(`getForecastSeries` is the entry point, so no caller can obtain a series
without the verdict on whether it may be drawn), and ABL-469's
`recommendedModelService.test.ts` — which landed in between — calls it directly
to assert the serving path is untouched. Three `TypeError: getForecastData is
not a function` failures, no conflict marker anywhere. This is the same hazard
the ABL-388 entry below records for `toEqual` under a merge, in its other form:
a *removed export* is invisible to a textual merge, and only a real run finds
it. Run the suite after resolving, never just the resolved files.

Re-measured 2026-08-20 on ABL-498, branched from `main` at `5cf5b4c` (which
carries the ABL-289 merge): **105 server test files / 2,034 tests**, all
passing, zero skipped, `tsc --noEmit` exit 0, under **v24.18.0**. ABL-498 is
**+1 file / +33 cases** — `release/strandedWork.test.ts`, and nothing else; its
`checkUnmergedWork.ts` and CLAUDE.md edits add no case. That delta was settled
without a second checkout by re-running the same tree with the one new file
excluded, which reported **104 / 2,001** — the figure recorded in the paragraph
below, corroborated rather than derived from it. The file count needed no run at
all: `git ls-tree -r main --name-only | grep -c '^server/src/.*\.test\.ts$'`
returns 103 at `5cf5b4c`, plus the one `scripts/` file the server suite also
discovers (`server/vitest.config.ts:11`) = 104.

Green as of 2026-08-14, measured on ABL-289 after merging `main` at `7965255`
in: **104 server test files / 2,001 tests**, all passing, zero skipped. `main`
itself measures **102 / 1,944** on the same tree, so ABL-289 is **+2 files /
+57 cases** (`lib/classifyRequest.test.ts`, `services/visitorCounters.test.ts`,
plus added cases in `app.test.ts` and `routes/opsStatus.test.ts`). An earlier
reading of **94 / 1,792** on ABL-305 at `8298dad` is what that same rule below
predicts going stale — the floor moved, the work did not.

**Both figures were re-measured on 2026-08-20 in the repaired primary checkout
(ABL-460), on unmodified `origin/main` at `5cf5b4c`, and both suites now run:**

| suite | files | tests | typecheck |
|---|---:|---:|---|
| `cd server && npx vitest run` | **104** | **2,001** | `npx tsc --noEmit` exit 0 |
| `cd client && npx vitest run` | **51** | **678** | `npx tsc -b --force` exit 0 |

Fewer tests passing than that means something broke. Two claims this replaces,
both of which had become false and neither of which was a code defect:

- **"The client suite could not be run in this checkout"** — it was blocked
  before it booted by an absent `@rolldown/pluginutils`. That package was
  missing because it had been deleted out of the root `node_modules` (note 4
  — not the incomplete install ABL-460 recorded); it is
  present now and all 51 files run. The last figure recorded under the blockage
  was 50 files / 666 tests on 2026-08-13, so the repair reveals ABL-289's
  `lib/opsTrafficRows.test.ts` plus one more case than the +11 that entry
  predicted. Re-measure rather than reconciling against 666.
- **"`tsc --noEmit` reports the same 7 pre-existing `@radix-ui/*` TS2307 errors
  in `components/ui/*`"** — those were every `@radix-ui/*` package having been
  deleted by the same walk, not a pre-existing condition of the code.
  There are none: `npx tsc -b --force` exits 0 on `origin/main`. **A TS2307 in
  `components/ui/*` is now a real failure and must not be waved through as
  expected.**

See "Troubleshooting the dev server" note 4 for the completeness check that
distinguishes a broken tree from a broken change, and for why the repair was
additive rather than an `npm install`.

**Both of those client claims are environment-specific, and neither reproduced
on 2026-08-20 (ABL-469).** In a per-issue execution worktree with its own
complete `node_modules`, the client suite boots and runs clean —
`@rolldown/pluginutils` is present, and `tsc --noEmit` reports **zero** errors,
not the 7 `@radix-ui/*` TS2307s. So both are properties of the primary
checkout's incomplete install (see the "Measure `node_modules` completeness
first" lesson), not of the client suite, and a run that hits either should
measure its own tree before recording it as the state of the world.
Measured there on unmodified `main` at `5cf5b4c`: **client 51 files / 678
tests, server 104 files / 2,001 tests** — the server figure reproducing the one
above exactly, which is what makes the client correction trustworthy rather
than a second unverified number. ABL-469 adds **+1 client file / +26 cases**
(`dashboard/autoSelection.test.ts`, plus the auto-selection block in
`hooks/useForecastModels.test.ts`) and **+2 server files / +45 cases**
(`services/bestForecastModel.test.ts`,
`services/recommendedModelService.test.ts`, plus the additive-recommendation
block in `routes/forecast.test.ts`), landing at **52 / 704** and **106 /
2,046**, both typechecks clean.

**The rule below cost ABL-399 a correction on its own branch, which is the best
evidence it is real.** ABL-399 measured 89 / 1,661 against `50d7a72` and wrote
that here. PR #29 (ABL-373, `/v1/accuracy`) then merged underneath it, adding
three `v1/data`/`v1/routes` test files that branch had never run — so the same
unchanged work then measured 92 / 1,715. The figure was a fresh run on the merged
tree, not `1,661 + 54`. Re-measure after merging the base in, not only after
writing the code; and settle the *file* count from the tree, which needs no run
at all — `git ls-tree -r origin/main --name-only | grep -c
'^server/src/.*\.test\.ts$'` returns 91 at `8298dad`, plus the one `scripts/`
file the server suite also discovers (`server/vitest.config.ts:11`) = 92, plus
ABL-305's two new files = 94.

ABL-399 is **+1 server file / +13 server cases**, and touches no client test:
`services/actualsSource.test.ts` is the new file at 9 cases,
`routes/forecast.test.ts` goes 6 → 9 in its actual-column block (three
assertions about the frozen table's semantics replaced by six about the new
ones), and `routes/forecastComparison.test.ts` gains 1. It also **deletes** the
last `energy_renewable` read from `server/src`; the table stays in
`src/test/fixtureDb.ts` deliberately, because its `DEFAULT 0` is what the
fabricated-actual tests measure against.

**Both halves of the previous figure were stale, and the file-count half was
decidable without running anything — which is the lesson.** The text this
replaced claimed `83 server test files / 1,563 tests`, measured on ABL-352
merged with `origin/main` at `cf20527`. Two merges later, `origin/main` at
`b6cb322` measures **87 files / 1,639** — so the claim was short by 4 files
and 76 cases *before this branch existed*, and anyone sizing a regression
against it would have read a green suite as 82 cases missing. The file count
never needed a run: `git ls-tree -r b6cb322 --name-only | grep -c
'^server/src/.*\.test\.ts$'` returns 86, plus the one `scripts/` file the
server suite also discovers (`server/vitest.config.ts:11`), and that command
needs no `node_modules`, no matching Node ABI and no free replica. Settle a
file count that way; only the test count needs a run.

ABL-388 itself is **+1 server file / +6 server cases**, and touches no client
test: `services/wape.test.ts` is the new file at 9 cases,
`crossCountryMetricsService.test.ts` loses the 5 `wape` cases that moved into
it and gains 1 re-export guard (−4), and `routes/tsoForecast.test.ts` gains 1.
Every other file it touches changed assertions without changing their count.

**That delta is the stable number here; the headline above it has already gone
stale once, while this very branch sat in review.** ABL-388 was measured at
88 / 1,645 against `b6cb322`, which was `origin/main` when it was written. PR
#26 (ABL-353) then merged underneath it, taking `origin/main` to 87 / 1,642 —
so the same unchanged branch now measures 88 / 1,648. Nothing about the work
moved; the floor did. That is the ABL-234 rule in its least obvious form: a
count can go stale between opening a PR and merging it, so re-measure after
merging the base in, not only after writing the code.

**Merging that base in also broke two assertions git had merged cleanly, which
is the failure mode worth knowing about.** `routes/tsoForecast.test.ts` is the
one file both branches edited, and only some of it conflicted. ABL-353's PT
case — the one asserting an unreported type publishes no score — sits far
enough from ABL-388's edits that git took it verbatim, so it kept a full
`toEqual` on a metrics object that had since grown a `wape` key, and failed
with no conflict marker to warn anyone. `toEqual` is exact, which is what makes
it the right assertion for a "no flawless 0" case and also what makes it break
silently under a merge that adds a field. Two conflicting hunks, two clean-
merged failures: after resolving markers here, run the suite before trusting
the resolution.

**That server figure is a fresh run, and it had to be — every figure available
to derive it from was stale within the hour.** The text this replaced claimed
77 / 1,401, measured on ABL-351 before PR #23 (ABL-303) merged; adding ABL-311's
own `+9` `release/` cases to it predicts 1,410, and `origin/main` at `cf20527`
actually measures **1,555**. The gap is ABL-303's `/v1` resource endpoints,
which landed after that sentence was written and were never counted into it.
This is the ABL-234 rule paying for itself twice in one run: a count is only
true of the tree it was measured on, and the arithmetic is not a substitute. The
deltas below explain movement; they are not to be summed.

It paid for itself a **third** time an hour later, which is why this paragraph
is worth reading before trusting any number above it. ABL-352 measured
83 / 1,554 against `eac20ed` and opened a PR saying so; ABL-311 merged in the
meantime, and both branches had independently rewritten this same sentence.
ABL-352 adds **+8 server cases** (3 in `routes/dashboard.test.ts`, 5 in
`routes/countries.test.ts`) and **no new file**, and touches no client test —
but 1,563 above is a fresh `npx vitest run` on the merged tree, not
`1,555 + 8`.

ABL-351 preceded all of it, adding +2 server files
(`services/renewableTotal.test.ts`, `routes/renewables.test.ts`) and +34 server
cases over the 75 / 1,367 that `main` measured immediately before it; it touches
no client test either.

ABL-353 (ABL-324 tranche 3) adds **+3 server cases** in the existing
`routes/tsoForecast.test.ts` and no new file, and touches no client test.

**It paid for itself a fourth time, and this one is the cleanest illustration
of the rule.** ABL-353 measured 83 / 1,558 on its own merge and wrote that
number here; ABL-352 then landed and rewrote the same sentence to 83 / 1,563;
and PR #27 (ABL-302, `/v1` quotas and rate limits) landed between the two,
adding four `v1/quota/` test files that **neither branch had ever run**. Every
one of those three figures was a fresh measurement, honestly taken, and all
three were wrong by the time they were read — because each measured a tree that
did not yet contain a change already merged elsewhere. The 87 / 1,642 above is
this branch re-measured after merging `b6cb322`; do not reconcile it against
1,558, 1,563 or `1,563 + 3`, and expect it to go stale the same way.

**Neither input figure survived, and neither was added up.** Local `main` read
49 client files / 657 tests and 63 server files / 1,026 tests at `4977f8a`;
`origin/main` read 49 / 644 and 66 server files / 1,114 at `cc28802`; their
merge read 50 / 666 and 75 / 1,367 at `a8d6fe8`. The sides touch disjoint code
— `CLAUDE.md` was the only file every one of them edited — so each figure is a
fresh `npx vitest run` on the tree it names, per the ABL-234 rule below. The
deltas recorded further down explain the movement; they are not to be summed.

**That `cc28802` read `87aaa1c` until it was corrected here, and the rule this
paragraph states is exactly what the mislabel broke.** `66 / 1,114` is a real
measurement — of `cc28802` (PR #19, ABL-300), one merge *before* `87aaa1c`
(PR #21, ABL-301), whose six new `v1/usage/*` test files take that tree to
**72**. So a reader reconciling `66 -> 75` credited the local-`main` merge with
`+9` server files when it contributed `+3`, and ABL-301 with none when it
contributed six. **Settle a file count from the tree, not by re-running
anything**: `git ls-tree -r <ref> --name-only | grep -c '^server/src/.*\.test\.ts$'`
(plus the one `scripts/` file the server suite also discovers —
`server/vitest.config.ts:11`) is decidable at any commit, needs no
`node_modules`, no matching Node ABI and no free replica, and is what settled
this. It reads 63 at `4977f8a`, 66 at `cc28802`, 72 at `87aaa1c`, 75 at
`a8d6fe8`, and 83 at both `eac20ed` and `cf20527` — matching every figure
recorded beside those commits except the one corrected here. It cannot check a
*test* count, which is why that half still needs a run.

Both suites were run under **v24.18.0**, which is not optional — see
"NODE_MODULE_VERSION mismatch" below, and note that all 666 client tests pass
under it, including the `dashboardStore.test.ts`/`windowLabel.test.ts` cases
that fail under v25.6.1 for the `storage.setItem` reason recorded there.

**The server figure carries one caveat, which is environmental and not a
regression: it moves depending on whether the shared replica is free.**
`services/generationService.test.ts` ends in an opportunistic `describe` against
the read-only development replica at `C:/Code/able/data/energy_dashboard.db`.
The 1,642 above was measured with that replica **reachable**, so those cases are
included. When it is not reachable the file contributes fewer — and when it is
*locked* rather than absent, the file used to not collect at all and contribute
none, which is the state the next paragraph is about.

**The third state — locked — used to take the whole file down, and ABL-311
fixed that.** The guard tested only `fs.existsSync`, but the open runs at module
evaluation, so during the twice-daily DB sync (ABL-220, ABL-249 — a 3.6 GB
rollback journal was observed on 2026-08-12) the readonly open raised
`SqliteError: database is locked` and the throw became a **collection** error
that took the whole file down, including the ~46 fixture-backed cases beside the
opportunistic ones that touch no replica at all. That is the worst shape a test
outage can take: the run reports "no tests" for the file rather than naming an
assertion, so a green-looking suite is quietly dozens of cases short exactly
when someone running `predone` is reading it as permission to ship. A lock is
not absence — and neither is a corrupt header or a permissions error — so
`replicaHasGenerationTable` now **catches** (`generationService.test.ts:812`)
and skips the opportunistic block while the rest of the file runs.

So a server count a little under 1,642 may simply mean the replica was busy —
but a *file count* below 87 is no longer explainable that
way, because a locked replica now skips rather than fails to collect. Do not
"fix" this file by deleting the replica check.

(ABL-300 added four server files — `v1/keys/keyFormat.test.ts`,
`v1/keys/sqliteApiKeyStore.test.ts`, `v1/keys/keysCli.test.ts` and
`v1/auth/apiKeyAuth.test.ts` — plus new cases in the two ABL-304 files it
touches: +4 files / +160 cases. It changed no client file.)

(ABL-311 re-measured this, and the correction was large. The whole chain is
kept because every link in it was a stale figure cited as a live one. The entry
before ABL-311 read 56 server files / 863 tests, taken before PR #17 (ABL-304)
merged as `c3f0dac` and so predating its +5 files / +125 tests: 56 + 5 = 61,
863 + 125 = 988, measured on unmodified `origin/main` at `1ffbae5`. ABL-311
then added `release/publishState.test.ts`, +1 file / +14 tests, giving
62 / 1002 including one skip. The client figure survived all of that, because
ABL-304, ABL-311 and ABL-300 are server-only — but **ABL-282 (PR #16) moved
it**, landing a component-test environment (`jsdom`, `@testing-library/react`)
and a `LoadTab.test.tsx` change. Re-measured here rather than carried forward,
the client suite is **49 / 644**, so the 48 / 640 that stood through everything
above is retired: +1 file / +4 cases. A count is only true of the tree it was
measured on — the ABL-234 rule below, gone stale twice in one day exactly the
way that rule predicts.)

(Note for whoever measures next, learned the hard way this run: ABL-282's
`jsdom` and `@testing-library/*` are new dependencies, so a worktree created
before PR #16 will not have them and the client suite cannot run until you
`npm install`. Do that install under **v24.18.0** as well: `prebuild-install`
resolves the `better-sqlite3` binary against the running Node, so installing
under the v25.6.1 first on `PATH` is the same ABI-141 trap the standing
instruction below documents for `npm rebuild`, arrived at by a different route.
Installed under v24.18.0 this run, `node -p "process.versions.modules"` reports
**137** and the module loads, which is the check worth doing before trusting a
count.)

### A raw control byte makes a test file invisible to review

Write control characters in test fixtures as **escapes** (`'\0'`, `'\x1b'`),
never as the raw byte. A single `0x00` anywhere in a file makes git classify the
whole blob as binary: `git diff --stat` reports `Bin 9542 -> 9543 bytes` instead
of line counts, the PR renders the file as *0 additions, 0 deletions*, and the
file will not merge line-wise. ABL-300 hit this — `v1/keys/keyFormat.test.ts`
held a literal NUL in a hostile-input list, and the reviewer could not read the
diff of the most security-relevant test in the change. It was first written off
as a GitHub rename-detection artifact, which it was not; `git diff --stat`
saying `Bin` on your own machine is the tell that settles it. `'\0'` is the same
single NUL character at runtime, so nothing about the test weakens. If a PR
shows a text file as `0 additions`, check for a stray control byte before
believing any explanation that blames the renderer.

(Measurement conditions, which are not optional. Run under **v24.18.0**: see
the two measurement notes below for why a count taken in a tree shared with a
concurrent run is not trustworthy, and the `storage.setItem` note for why the
Node version decides whether the client suite passes at all. ABL-311 measured
in a throwaway clone at `1ffbae5` with `node_modules` junctioned from the
primary checkout, because that checkout was held the whole time; the figures
above were measured in this branch's own worktree with its own `node_modules`,
which no other run holds. The *worktree* being exclusive is not the same as the
*database* being free, which is the distinction the 66th-file caveat above turns
on: source isolation is cheap, but the one shared 376 GiB database is a single
resource and any suite that touches it inherits whatever ingest is doing.)

(ABL-287 added five server files — `lib/opsAlertRules.test.ts`,
`lib/opsAlertEngine.test.ts`, `lib/opsAlertStateStore.test.ts`,
`services/opsAlertChannel.test.ts`, `services/opsAlertScheduler.test.ts`, 102
cases between them — plus a `commitDrift` assertion in the existing
`routes/opsStatus.test.ts` and an allowlist entry in
`src/docs/claudeMdCitations.ts`. It added no client test: its client change is a
mirrored type and a banner that now reads the server's verdict. Measured fresh
on the merge with `main` (ABL-288 + ABL-295), not summed — the branch alone read
50/770 before that merge, and that figure does not survive here.)

(ABL-295 added `services/ingestLog.test.ts` (+1 server file / 15 cases) and 11
more cases in the existing `routes/dataFreshness.test.ts`, plus
`components/layout/lastRefreshed.test.ts` (+1 client file / 9 cases). Measured
fresh on the merge, not summed: the branch alone reported 45/646 and 46/599
before merging `main`, and neither of those figures survives here — which is
the ABL-234 rule below in action.

One environment note ABL-295 hit that the NODE_MODULE_VERSION section below
does not cover: **a fresh git worktree has no `node_modules`, and `npm install`
under npm 11.16 does not run install scripts.** It prints an `allow-scripts`
warning and leaves `better-sqlite3` without its native binary and `esbuild`
without its platform binary, so both suites fail to start before any test runs.
Run each package's script directly — `node install.js` in `node_modules/esbuild`
and `node_modules/vite/node_modules/esbuild` — rather than
`npm approve-scripts`, which writes an `allowScripts` field into `package.json`
and dirties the tree. `better-sqlite3@11.10.0`, which the server pins, has no
Node 24 prebuild at all; copy `build/Release/better_sqlite3.node` from the
primary checkout, which carries a working build of the same version.

Also: **`core.autocrlf=true` here, and some committed files carry CRLF in the
object anyway** — `client/src/types/index.ts` is one. Editing such a file with
a tool that rewrites it LF-only (`sed -i`) turns a 60-line addition into a
1,468-line whole-file diff and a guaranteed merge conflict. If `git diff --stat`
shows a file you barely touched rewritten end to end, that is the cause; restore
its CRLF and stage with `git -c core.autocrlf=false add <path>`.)

(ABL-285 added `forecastVintage.test.ts`, +1 client file / +20 tests. ABL-292
then deleted the client's `lib/opsStatusThresholds.*`, -1 file / -15 tests, and
added `server/src/lib/opsStatusThresholds.test.ts`, +1 server file / +31 tests
counting the derived-state cases in `services/combinedOpsStatusService.test.ts`
and `routes/opsStatus.test.ts`. ABL-288 then added +5 server files
(`lib/diskHeadroom.test.ts`, `services/opsSnapshot.test.ts`,
`services/opsSnapshotStore.test.ts`, `services/opsSnapshotScheduler.test.ts`,
`services/opsHistoryService.test.ts`) and +1 client file
(`lib/opsHistorySeries.test.ts`). The figure above is a fresh run on the merge,
not those deltas summed — see the ABL-234 note below on why a count is only
true of the tree it was measured on.)

`src/docs/claudeMdCitations.test.ts` is what keeps the `file:line` references
in this document honest: it resolves every one of them and fails if a citation
lands on the wrong line. It caught this merge shifting
`computeDiskHeadroom` by two lines. If you move code that this file cites,
that suite tells you before a reader is misled — so run the server suite after
editing either.

Two measurement notes worth having before you diagnose a "failure":

- **Measure on a clean tree, and only count files you wrote.** A count taken in
  the primary checkout while another run's untracked files are on disk is
  inflated by them. This bit twice on 2026-08-12: a 46/610 client figure was
  recorded here from a tree carrying a concurrent run's in-flight work, and the
  45/590 figure before it likewise. Run `git status` first; if it is not clean,
  measure in a worktree instead (`git worktree add`, then junction or install
  `node_modules`) — that is how ABL-292's numbers were taken.
- **The `storage.setItem is not a function` failures are not intermittent —
  they are the Node version on your `PATH`, deterministically** (ABL-311).
  Earlier entries here recorded 20 failures in
  `dashboardStore.test.ts`/`windowLabel.test.ts`, then recorded them as having
  "not reproduced", and called the quirk intermittent. It is not intermittent —
  and the drift was in *this document*: **ABL-263 had already root-caused it
  exactly**, down to the `--localstorage-file` warning, and is open with that
  diagnosis. Do not re-investigate it; read that issue.
  **Node v25.6.1 defines a global `localStorage` object whose `setItem` is
  `undefined`** unless `--localstorage-file` is passed; the store's
  `createJSONStorage(() => localStorage)` gets that truthy-but-hollow object and
  zustand calls straight through to a missing method. Under **v24.18.0**
  `typeof localStorage === 'undefined'`, zustand's persist middleware takes its
  no-storage path, and all 640 client tests pass — that tree's figure; the
  merged tree reads 644, see "Testing" above. Verified both ways on the same
  tree at `1ffbae5`, and again 60 commits back at `cb83944` with identical
  results — so it never depended on a branch. This is the **same root cause as
  the NODE_MODULE_VERSION section below**: `C:\Program Files\nodejs` (v25.6.1)
  shadowing the nvm v24.18.0 install. One `export PATH` fixes both suites.

### NODE_MODULE_VERSION mismatch

If `cd server && npx vitest run` fails ~24 files at *import* time with

```
The module '…/better_sqlite3.node' was compiled against a different Node.js
version using NODE_MODULE_VERSION 137. This version of Node.js requires
NODE_MODULE_VERSION 141.
```

then nothing is broken in the code — the `node` first on your `PATH` is not
the one `better-sqlite3` was compiled against in this checkout. On the able
workstation `C:\Program Files\nodejs` (v25.6.1, ABI 141) shadows the nvm
install. Run the suite with the matching Node rather than rebuilding the native
module, which would just move the breakage to whoever has the other one first
on `PATH`:

```bash
export PATH="/c/Users/guill/AppData/Local/nvm/v24.18.0:$PATH"
cd server && npx vitest run   # see "Testing" above for the current figure
```

That `export` fixes the client suite too, for a different mechanism with the
same cause — see the `storage.setItem` note above. Set it once per shell and
run both suites. (`/c/nvm4w/nodejs2/nodejs` is the nvm4w "current" symlink and
also resolves to v24.18.0; either path works, the versioned one is stable.)

**Since ABL-309 the suite tells you this itself.** A vitest `globalSetup`
(`server/vitest.config.ts:16`) opens an in-memory database before any test file
loads; on an ABI mismatch it halts the run with a single error naming both ABI
numbers, the Node to re-run under, and why not to `npm rebuild`. So you get one
explanatory failure instead of ~24 red files with a `bindings.js` stack and no
assertion named. `SKIP_NATIVE_ABI_PRECHECK=1` bypasses it if you deliberately
want the ABI-independent tests under a mismatched Node.

**Which Node is correct flips, so do not memorise a version — read the error.**
The binary is whatever the last `npm rebuild` in *any* checkout produced: it was
ABI 137 on the morning of 2026-08-12, ABI 141 by 15:35, and back to 137 by
15:36. The guard is deliberately written to report the numbers it finds rather
than to name a version (`parseAbiMismatch`, `server/src/lib/nativeAbi.ts:68`),
because a guard that hardcoded "use Node 24" would itself become the next wrong
instruction. `137` is Node 24 and `141` is Node 25; the error states both.

This is a standing instruction, not a suggestion, and it was re-tested under
ABL-287: `npm rebuild better-sqlite3` under the v25.6.1 on `PATH` does fix the
suite for that Node — and immediately breaks it for anyone following the
`export PATH` line above, because an ABI-141 binary cannot load in v24.18.0.
That rebuild was reverted the same run — and it has since happened again, which
is why the section above says to read the error rather than trust any version
written here. `server/node_modules` is junctioned into every per-issue worktree,
so one `npm rebuild` re-points the ABI for all of them at once. If you want the
default `node` to work without the export, that is a real decision about a
shared workstation and needs the CEO, not a `npm rebuild` in passing.

Verified 2026-08-12 on ABL-309, ABI-137 binary: under v24.18.0 the tree is
`61 passed (61)` / 988 tests; under v25.6.1 the guard halts the run with its
one-error message and no test file loads. Bypassing the guard on that same Node
(`SKIP_NATIVE_ABI_PRECHECK=1`) reproduces what everyone saw before it:
`24 failed | 38 passed (62)`, 81 tests failed — matching the counts ABL-309 was
filed with. Every failure is the same `bindings.js` import error and none names
a test assertion, which is how you tell it from a real regression: a real one
names an assertion. `require('better-sqlite3')` alone
does *not* detect this — the addon is not loaded until a `Database` is
constructed, which is why the failures scatter across DB-touching files instead
of landing in one obvious place, and why the guard constructs one. Pure helpers
are deliberately insulated from this:
`services/combinedOpsStatusService.test.ts:17` mocks `config/database.js` out,
and `lib/opsStatusThresholds.ts` imports only *types* from the DB-touching
modules (type imports erase at compile time), so both suites run under either
Node. Prefer that shape for new logic.

(ABL-277 added the divergent-forecast-basis rule: **+19 server tests / +1
server file**, measured against a stashed-changes baseline of 620/44 in this
same worktree rather than derived — `services/loadForecastBasis.test.ts` is
the new file at 11 cases, and `routes/tsoForecast.test.ts` goes 15 → 23. Plus
+5 client cases in
`dashboard/modelComparison.test.ts` — no new client file. It also gave the
shared fixture an **NL** country, on `NEXT_DAY` rather than `WINDOW`
specifically because `crossCountryMetricsService.test.ts` seeds its own NL
`T`/space conflict pair at `2026-07-01 01:00:00`; a second NL row at that
timestamp would be an exact `(country_code, timestamp_utc)` duplicate, which
is the one thing that test's no-fan-out property is measured against. The
server figures here were measured in a **fresh worktree with dependencies
installed from scratch** — note the repo-root `package.json` holds
`@types/react-simple-maps`, so `npm install` in `client/` and `server/` alone
leaves `npx tsc -b` failing on `react-simple-maps` with TS7016; install at the
repo root too before diagnosing that as a code error.)

**Run the suite on Node 24, not on whatever `node` resolves to.** This
workstation's default is Node 25 (`NODE_MODULE_VERSION` 141) while
`server/node_modules/better-sqlite3` is prebuilt for Node 24 (137), so every
server test file that opens the fixture DB fails to *import* with "compiled
against a different Node.js version". Measured 2026-08-12 on an unmodified
tree: **24 of 46 server files, 81 cases, failing for that reason alone.**
`nvm use 24.18.0` first, or run the binary directly:

```bash
PATH="$HOME/AppData/Local/nvm/v24.18.0:$PATH" node ../node_modules/vitest/vitest.mjs run
```

`npm rebuild better-sqlite3` also clears it, and then breaks the next agent who
is on 24. Check `node -v` before concluding you broke 81 tests.

(ABL-289's own delta: **+1 client file / +11 cases**
(`lib/opsTrafficRows.test.ts`) and **+2 server files / +57 cases**
(`lib/classifyRequest.test.ts`, `services/visitorCounters.test.ts`, plus new
cases in `app.test.ts` and `routes/opsStatus.test.ts`). Measured in a dedicated
worktree rather than in the primary checkout, deliberately: two other runs were
writing to that tree at the time and one had already dropped an untracked test
file into `client/src/components/dashboard/`, which inflated the client count
by a file and 18 cases belonging to neither change. Measure a count against a
tree that holds only the change it describes — see "Shared checkout" below.)

The 20 `storage.setItem is not a function` failures in
`dashboardStore.test.ts`/`windowLabel.test.ts` the previous baseline recorded
(ABL-263; the ABL-203 paragraph below documents the quirk) did **not**
reproduce on this run — all 601 client tests passed. It is environment-
dependent, not a standing expectation. Re-measure; do not assume either count.

(Historical, for the ABL-238 figures this paragraph replaced: both were a fresh
`npx vitest run` on ABL-238 merged with `origin/main`
at `0871259` — what `main` becomes when this lands — not arithmetic on the two
branches' separate claims. Measured on a detached `origin/main` immediately
beforehand: **42 server files / 604 tests** and **44 client files / 575 tests**,
555 passing with the same 20 failing and no ABL-238 file on disk, which is what
establishes those 20 as `main`'s rather than this branch's. ABL-238 adds +2
server files / +16 cases (`services/peerOpsStatus.test.ts`,
`services/combinedOpsStatusService.test.ts`, and new cases in the existing
`routes/opsStatus.test.ts`) and +1 client file / +15 cases
(`lib/opsStatusThresholds.test.ts` — since deleted by ABL-292, which moved that
derivation and its cases to `server/src/lib/opsStatusThresholds.test.ts`).)

(`main` arrived here already claiming 41/602 while measuring 42/604: ABL-234
counted correctly, but ABL-266 landed afterwards and
`server/src/release/checkUnmergedWork.test.ts` is exactly the missing +1 file /
+2 cases. A count is only true of the tree it was measured on — re-measure it,
never re-derive it from two branches' claims. The server file count includes
the repo-root `scripts/backfillModelGuard.test.ts` (43 files under `server/`
plus that one): ABL-244 added it together with `server/vitest.config.ts:11`,
whose `include: ['src/**/*.test.ts', '../scripts/**/*.test.ts']` is what makes
repo-root scripts discoverable from the server suite at all.)

(ABL-234 added the Core / all-coupled-borders scope toggle. Client: 3 new
files — `lib/coreNetPositionSeries.test.ts`, `components/map/
netPositionMapScope.test.ts`, `components/dashboard/coreNetPositionNote.test.ts`
— plus new cases in `lib/netPositionScope.test.ts` (scope-aware copy) and
`store/migrate.test.ts` (the v10 clause). Server: no new file; 22 new cases
across `services/coreNetPositionService.test.ts` and a rewritten
`routes/coreNetPosition.test.ts`, which now asserts the revised contract
instead of ABL-230's provisional `{ points }` shape. Every net-position value
in both fixtures is real — the Core figures were fetched live from JAO on
2026-08-12 and the all-coupled ones read from the replica — specifically so
the France sign-disagreement case and the DE-LU false negative are pinned by
measurement rather than by invented numbers.)
(ABL-230 added the JAO Core net position ingest, server-only: 4 new files
(`services/coreNetPositionService.test.ts`, `services/
jaoCoreNetPositionCapture.test.ts`, `services/coreNetPositionScheduler.test.ts`,
`routes/coreNetPosition.test.ts`), 45 new cases, no client file touched. It
also fixed one pre-existing failure this checkout already carried, unrelated
to ABL-230 itself: `docs/claudeMdCitations.test.ts` had flagged the
`NetPositionTab.tsx` citation a few sections above (in "NetPositionTab") as
landing on a blank line at its old line numbers, 158 through 173 — ordinary
line drift from an earlier, unrelated change — corrected to the actual
`lastSeen` branch that citation was always describing, now
`NetPositionTab.tsx:270-284` (verified: the same "stopped publishing a net
position" ternary this section's own prose quotes). This branch was rebased
onto `main` 2026-08-12 after ABL-221's second pass, ABL-237 and ABL-240 landed
there (492 server tests / 34 files, 520 client tests / 41 files, per the
paragraphs below) — ABL-230's 45 server cases land on top of that base, not
the 421/27 this entry originally measured against before the rebase. The
rebase also shifted the `/api/health` line number the "host/process KPIs"
paragraph below cites — `coreNetPositionRouter`'s mount line now lands above
it — and that citation was updated to match. Neither the 492/34 nor the 520/41
figures below
survive a fresh count in this checkout either (35 server test files, 523
client tests present before this rebase's own additions) — the same
never-fully-reconciled-merges drift the ABL-214 paragraph names; this entry
reconciles only ABL-230's own delta against the top-line figures actually
measured just now, not the whole gap.)

ABL-221's second pass — the user's "remove the whole banner, not just the
mini graphs" follow-up comment — deleted `AbleStatRow.tsx` outright. The first
pass, `6350836`, had only dropped its sparklines, which was not what "confusing
banner" meant. Gone with the component: its sole data source
`useDashboardOverview` (`useDashboardData.ts`) and `lib/readingFreshness.ts`,
the per-reading staleness classifier "Current load" used with no other caller
— see "The header stat row was removed" above. That dropped 1 client file / 14
tests (`readingFreshness.test.ts`); no server file changed. Measured
immediately before this change: 534 client tests / 42 files — already above
the 488/39 this entry had recorded, for the same never-fully-reconciled-merges
reason the ABL-214 note below names; this entry reconciles only against
ABL-221's own delta, landing at 520/41, not the whole gap.

ABL-262 (the `/api/forecasts/compare` load guard) added one server file
(`routes/countries.test.ts`, 6 cases) and extended `routes/forecast.test.ts`
by 5, for **+11 server tests / +1 server file**. The headline figure above is
deliberately *not* restated from that run's measurement: the shared checkout
held three runs' uncommitted work at the time (ABL-238's ops-status page,
ABL-244's backfill guard — which also drops in a `server/vitest.config.ts`
broadening discovery to `../scripts/**/*.test.ts` — and this one), so the
543/38 it measured in `server/src` is not attributable to any single merge.
Prefer a stated delta over an absolute measured on a contaminated tree; if you
see a server figure far above 492/34, that is the backlog of unreconciled
merges this section already documents, not a regression.

ABL-237 (the `/api/ops/status` KPI endpoint, merged separately) added three
server files — `services/hostMetrics.test.ts`, `services/freshnessRollup.test.ts`,
`routes/opsStatus.test.ts`. ABL-240 (this merge — generalizing the net-position
ingest path to wind shadow candidates) added one server file
(`routes/netPositionIngest.test.ts`, 6 cases) and extended two others
(`services/netPositionIngestService.test.ts` +5, `config/forecastModels.test.ts`
+1). The 492/34 server figure above is measured on this merged tree with a
Node version matching the compiled `better-sqlite3` native module — see
"NODE_MODULE_VERSION mismatch" above if `cd server && npx vitest run` throws
that error instead of running. That section pointed at nothing until ABL-292
wrote it: it was cited here and in
`services/combinedOpsStatusService.test.ts` for weeks as if it existed.)
(That server figure predates several since-merged branches already reflected
in this checkout's history — e.g. ABL-190/ABL-221 — which is why a fresh run
here shows more than 421/27 even before ABL-214's own tests; this entry was not
re-reconciled against all of them, only against the delta ABL-214 itself adds.
ABL-214 touched no client file. It added 9 server cases across three existing
files — `timestampFormOnClause` cases in `utils/timestamp.test.ts`, and a
conflicting-T/space-pair-does-not-fan-out case plus a T-form-only-rescue case
in each of `services/mlForecastService.test.ts` and
`services/crossCountryMetricsService.test.ts` — no new file.)
(ABL-204 extended the multi-model overlay to Load and Price — two new files,
`dashboard/forecastLineTokens.test.ts` and `lib/multiForecastSeries.test.ts`,
plus new cases in `lib/forecastGap.test.ts` for
`describeForecastGapsForSelection` — which is where the client figure moved
from 474/37 to 488/39; it touched no server file. ABL-203 added the
net-position multi-model picker before it — `migrate.test.ts`'s v9 clause,
`useForecastModels.test.ts`'s `resolveMultiSelection` cases,
`chartAdapters.test.ts`'s `adaptNetPositionMultiSeries` cases, and a new file,
`dashboard/netPositionModelColors.test.ts` — which is where the client figure
moved from 449/36 to 474/37; it touched no server file, and the 411->421
server figure this entry used to carry already held on unmodified `main`
before this branch, so it is not part of this change's delta. (One
shared-workstation caveat worth naming here rather than re-discovering: this
checkout's `npx vitest run` intermittently fails ~20 client tests in
`dashboardStore.test.ts`/`windowLabel.test.ts` with `storage.setItem is not a
function` — a `zustand`/`localStorage` environment quirk in this sandbox, not
a code defect. Verified identical on unmodified `main` with this branch's
changes fully stashed, including untracked files, before attributing it to
ABL-203; do the same before re-diagnosing it as a regression.)
ABL-166 removed `ForecastPortfolio` and its `portfolioRows.ts` helper — the
"Forecast performance by variable" card grid the CEO asked to drop from the
Forecast quality portfolio page, leaving the rest of that page, its nav entry,
and the per-country `ForecastTab` in place — which is where the client figure
dropped by 3 tests and 1 file, from 452/37.
ABL-156 merged ABL-146's generation-mix x-axis fix and ABL-151's fourth
freshness verdict — both landed done but stranded on branches misleadingly
named for other issues (ABL-101 and ABL-149, respectively, whose own fixes had
already shipped separately) — which is where the client figure picked up 3
more `chartTicks.test.ts` cases and the server figure picked up
`freshness.test.ts`/`dataFreshness.test.ts` cases for the `ended` verdict. The
server figure here is the pre-merge author's own verification, not a rerun in
this checkout: a pre-existing `better-sqlite3` native-module ABI mismatch
blocked `cd server && npx vitest run` in this shared workstation checkout at
merge time, confirmed identical on unmodified `main` before either merge, so
it predates and is unrelated to both changes. The 411 above is measured fresh
in this checkout, not inherited: merging the ABL-101 and ABL-149 branches
themselves on top of ABL-156's cherry-picked fixes (`3c48561`, `0116d60`)
added one more server case beyond the 410 ABL-156 reported.
ABL-153 reconciled `main` and `origin/main` after an 11-vs-6-commit
divergence and landed ABL-150's cross-country-metrics fix on top, which is
where the client figure picked up `ForecastPortfolio`/`portfolioRows.test.ts`
and the v8 `comparisonForecastType` migration cases, and the server figure
picked up `crossCountryMetricsService.test.ts`'s query-plan case. The server
figure moved from 189 / 13 in ABL-17, which added
`routes/forecast.test.ts` and `middleware/errorHandler.test.ts`; ABL-19 raised
the client figure and touched no server file; ABL-21 added
`utils/timestamp.test.ts` and one more `forecast.test.ts` case; ABL-23 added
`comparison/mapFill.test.ts` and touched no server file; ABL-13 added
`server/src/app.test.ts` and touched no client file; ABL-25 added
`services/degenerateForecast.test.ts` and
`dashboard/degenerateForecastNote.test.ts`, one per side; ABL-35 added cases to
all four of those plus `routes/netPosition.test.ts`, then a second pass added
`services/loadQuality.test.ts` and `routes/load.test.ts` for the impossible-zero
load rule and touched no client file; ABL-44 added `routes/generation.test.ts`
plus `getGenerationSeries` cases in `services/generationService.test.ts`
server-side, and `lib/divergingStack.test.ts` +
`dashboard/generationSeries.test.ts` client-side; ABL-54 added
`routes/prices.test.ts` server-side and `lib/priceWindow.test.ts` client-side,
one per side of the day-ahead window; ABL-60 added
`services/freshness.test.ts` + `routes/dataFreshness.test.ts` server-side and
`layout/freshnessPill.test.ts` client-side; ABL-15 added
`docs/claudeMdCitations.test.ts` server-side and touched no client file; ABL-76
merged five branches that had been closed but never merged, which is where
`lib/readingFreshness.test.ts` + `lib/forecastGap.test.ts` client-side and
`docs/claudeMdCitations.test.ts` + `utils/timestamp.test.ts`'s `toIsoUtc` cases
server-side actually arrived, and added `release/unmergedWork.test.ts`.)

### Before you mark an issue `done`

```bash
npm run predone            # from the repo root; = npm run check:unmerged -w server
```

**Publishing to `origin/main` is the last step of `done`, not an optional
one.** Prod is built from the remote. Work that is merged to local `main` and
not pushed has not shipped, however green its tests are and whatever the board
says. This has now recurred five times — ABL-79, ABL-98, ABL-136,
ABL-189/190/196, ABL-262/265, and on 2026-08-12 five issues (ABL-285, ABL-292,
ABL-288, ABL-290, ABL-295) all read `done` while local `main` sat **12 commits
ahead of `origin/main`**.

`predone` runs **three gates** — gate 2 is ABL-311's, gate 3 is ABL-498's:

1. **Per branch** — `done` + the work not on the target = shipping gap.
2. **`main` itself** — local `main` ahead of the target = **not published**
   (`release/publishState.ts`, pure, colocated test).
3. **Every local branch** — any commit whose patch is not on the target =
   **stranded** (`release/strandedWork.ts`, pure, colocated test). Reports;
   never fails. See below for why that is a decision rather than a weakness.

**Gate 1 asks git two questions, not one, and the second is why it can be
trusted.** Ancestry (`git merge-base --is-ancestor`) answers whether the *commit*
reached the target — not whether the *work* did. Cherry-pick or rebase the same
change onto `main` and the tip is no longer an ancestor while every line of it
is already there. Run against this repo on 2026-08-12, ancestry alone reported
**seven** shipping gaps of which **three were phantoms** — ABL-166 (`3c42ec8`),
ABL-216 (`484b3e2`) and ABL-249 (`d84e97b`), each fully cherry-picked. So a
branch that fails the ancestry test is then measured with `git cherry <target>
<tip>`: zero `+` lines means every commit's patch is already on the target, and
the branch is reported as `rebased` ("already on origin/main … safe to delete")
rather than failed. Four real gaps survived that filter and the command still
exited 1.

This is the difference between a gate people run and a gate people learn to
skim. It is also **fail-closed in the direction that matters**: a squash merge
collapses N commits into one whose patch-id matches none of them, so a
squash-merged branch still reads as novel and is still reported — over-reporting
there is the safe error, and this repo merges with merge commits anyway. An
unmeasurable count (`null`) falls back to ancestry alone rather than to an
all-clear, because a signal that could not be gathered must never read as
permission to ship. `release/unmergedWork.ts` holds the classification, pure,
with the phantom-vs-real cases pinned in its colocated test.

Gate 2 exists because gate 1 structurally could not see the common case. It
reads an issue identifier out of the branch name, and `main` has none, so
`issueFromBranch('main')` returns null and the verdict was `unattributed` —
"reported, not failed". A `main` twelve commits ahead printed one grey line and
the command exited **0**. Verified on a synthetic repo in the ABL-311 run: the
pre-ABL-311 checker exits 0 on a merged-but-unpushed `main`, the current one
exits 1. Gate 2 also survives the two shapes that leave gate 1 no tip at all —
deleting the feature branch after merging, and committing straight to `main`.

Gate 2 is deliberately **board-independent**: it asks git a question git can
always answer. A gate that needs a reachable network in order to fail is a gate
that fails open, and gate 1 does exit 0 when the board is unreachable.

**Gate 3 exists because gates 1 and 2 are both blind one level below where they
look, and neither is wrong on its own terms.** On 2026-08-20 this command
printed its clean-bill-of-health line — "No shipping gaps: every issue marked
done is on origin/main, and main is published." — while **five local branches
held the only copy of finished work**, including ABL-469 (`6d2c1f3`), a 16-file
feature with tests, +1804/-35. Gate 1 keys off *issue status* and ABL-469 read
`blocked`, so its branch printed as a quiet `in flight` line and was never a
failure. Gate 2 asks only about `main`, which sat at `0 ahead, 0 behind` because
the work was stranded a level below it. Nothing asked the question that matters:
*is any local branch holding a commit whose patch is not on the target?*

Four properties, each of which had already cost this repo something:

- **Patch identity, not ancestry** — the same rule gate 1 learned above.
  A raw `git rev-list --count origin/main..<branch>` reported **eleven**
  non-ancestor branches that day, of which **five were phantoms** already
  cherry-picked onto `origin/main` (ABL-166 `3c42ec8`, ABL-216 `484b3e2`,
  ABL-249 `d84e97b`, ABL-70 `9214114`, `claude/determined-merkle-7f23e0`).
  Quoting the raw count as a stranding figure would be this repo's signature
  defect committed by the check meant to catch it. Phantoms are **counted and
  not listed** — five verbose paragraphs about branches that are safe to delete
  is what pushes the one that matters off the top of the screen.
- **Counted by commit, not by ref.** Several branch names on one tip is the
  normal state of this checkout, not an edge case: the Paperclip
  execution-workspace name and the hand-cut convention name routinely coexist
  (`ABL-494-day-ahead-…` and `fix/abl-494-per-stream-day-ahead-deadline` were
  both `16f27cb`), and older tips carry up to five refs each. Findings are
  folded by tip and the extra refs listed under `also at:`, so the headline
  cannot overstate. The first real run of this gate did double-count `16f27cb`
  before that was added.
- **Size and age beside every entry.** This is the whole payload. Gate 1
  rendered ABL-469 (16 files, +1804/-35) and `fix/frontend-wal-mount` (1 file,
  +3/-1, 121 days old) as two indistinguishable lines; gate 3 sorts by size and
  prints `<n> commits; <files> +<ins>/-<del> vs merge base; <age>`. Note the
  size is **against the merge base**, not "unpublished lines" — for a partly
  cherry-picked branch it still counts the published hunks, and it is labelled
  that way rather than overclaimed.
- **Board-independent, like gate 2, and that is the point.** ABL-487 is the
  incident behind this: the GitHub push credential expired, so no branch *could*
  be published, and `predone` said everything was fine. That is exactly when the
  board half is least likely to be reachable and stranded work is most likely to
  be piling up, so gate 3 asks git and nothing else.

**Gate 3 reports and never fails, and that is measured rather than timid**
(`STRANDED_WORK_FAILS_CHECK`, `server/src/release/strandedWork.ts:69`). This is
one physical checkout shared by many concurrent runs, so several other agents'
in-flight branches are present at all times — on 2026-08-20, six commits held
novel patches and exactly one belonged to the run reading the report. Any
exit-code rule over that set is red on an ordinary working day, which is the
"cries wolf" failure gate 1's own header already names. What changed instead is
that the **summary can no longer read as an all-clear**: the clean line now
carries "But N local commits carry work that is not on the target — listed
above." Read that clause before you close anything. If a future checkout is
single-tenant, flipping the constant may become right — measure the branch
population first, do not infer it from this paragraph.

So: `predone` must read `0 ahead, 0 behind` before you mark the issue `done` —
and reaching that state is a **merge, not a push** (next section). If local
`main` is ahead, that content is stranded in this checkout: branch from it,
open a PR, and leave the issue `in_review` until the PR is merged. Do not
resolve gate 2 with `git push origin main`.

#### Every change ships as a PR the CEO merges

**Board ruling, 2026-08-13** — ABL-351, request_confirmation
`53530572-a65c-4c79-b1f2-b30c3b892ec4`, accepted 08:56:06Z. There is no class
of change an agent pushes to `origin/main` directly, and none an agent merges
itself — not its own PR, not a one-line docs fix. Push the branch, open the PR
against `main`, and leave the issue `in_review` until the CEO merges it.

This **supersedes the "PR or direct push?" split** that stood here for one day.
That section split by what the change touched — shared contracts and
security-sensitive code by PR; "a tab, a chart, a pure helper, a route that
reads existing tables, docs, tooling and tests" direct — arguing that requiring
a CEO merge on every issue makes an hourly heartbeat the bottleneck on all
work. The ruling heard that cost and accepted it. It is recorded here rather
than deleted, because the argument was published and reads as sound; an agent
who does not know it was decided will re-derive it. **Do not re-propose it.**

The bottleneck is also narrower than that argument implies: the merge is the
only serialized step, and the branch can be pushed and the PR opened the moment
the work is green. What waits on the CEO is publication, not the next issue —
so the correct response to an unmerged PR is to leave the issue `in_review` and
pick up other work, never to ship it another way.

The branch-per-concern rule stands, and the issue is not `done` until the work
is an ancestor of `origin/main`.

**`state: MERGED` is not a publication check — only content on `origin/main`
is.** A PR is merged into *its base branch*, and nothing requires that base to
be `main`. Found on the sibling `energy-forecast` repo on 2026-08-13: PR #11
reported `state: MERGED` on GitHub while its content was not on `main` at all,
because it had been opened against another PR's branch; it took merging PR #10
to actually publish it. So a green "Merged" badge answers *which branch did this
land on*, not *did this ship*.

This is a third stranding shape, distinct from the two above, and neither gate
sees it. Gate 2 cannot: the content never reached local `main`, so `main` is not
ahead of anything. Gate 1 can only see it while the head branch still exists
locally — against `origin/main` the tip fails ancestry and `git cherry` reports
`+` lines, so it is correctly named a gap — but merging a PR is exactly the
moment the branch gets deleted, and a deleted branch is a tip gate 1 never
enumerates. The merge destroys the evidence of its own incompleteness.

Two rules follow, and both are local, which is why they are rules rather than a
third gate. A gate that had to ask GitHub for a PR's base would fail open the
moment the token expired, which is precisely the failure mode
`gh`-token outages already produce here:

- **Open PRs against `main`.** If you deliberately stack one on another branch,
  the issue is not `done` when that PR merges — it is `done` when the bottom of
  the stack reaches `origin/main`.
- **Do not delete a branch until `git cherry origin/main <tip>` prints nothing.**
  That command is the whole publication check in one line, it needs no network
  and no board, and it is the same patch-identity test gate 1 runs. Empty output
  means every commit's patch is on the remote; anything else means the branch is
  still the only copy of something.

**A commit on a branch is not shipping.** ABL-76 found five issues marked `done`
whose branch was created, committed, and never merged — three of them absent
from `main` *and* `origin/main`, including ABL-58, a live confidently-wrong-
number defect that sat in prod for a week because prod is built from `main`.
Branch existence and issue status had both been read as proof of shipping, and
neither is.

The check joins `git merge-base --is-ancestor <tip> main` to the board's issue
status and fails only on `done` + unmerged (`release/unmergedWork.ts`, pure,
colocated test). In-flight, blocked and in-review branches are listed but never
failed — the whole point is a check nobody wants to disable. **Gate 1** needs
`PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY` / `PAPERCLIP_COMPANY_ID`; without them
it lists unmerged branches and exits 0 rather than guessing. **Gate 2 still
fails without any of them** — that is the point of keeping it board-independent.

It is deliberately **not** in the vitest suite: a test that failed whenever an
unmerged branch existed would be red on every working branch every day. Run it
at the moment you close an issue, which is the moment the defect is created.

Two conventions, and they are for different layers.

**Pure helpers get a colocated `.test.ts`.** `horizonBars.ts`, `sourceRows.ts`,
`windowLabel.ts`, `lib/dataScale.ts`, `comparison/accuracyScale.ts`,
`comparison/leaderboardRows.ts`, `comparison/mapFill.ts`, `store/migrate.ts`,
`dashboard/degenerateForecastNote.ts`, `config/forecastModels.ts`,
`server/src/utils/timestamp.ts`, `server/src/services/degenerateForecast.ts`
(which now classifies both the forecast and the actuals series),
`server/src/services/loadQuality.ts`,
`server/src/services/renewableTotal.ts` (ABL-324 tranche 1 — the NULL-aware
renewable total, plus the column mapping and the SQL builder that state the
same rule on the database's side of the wire; the test imports no
DB-touching module, so it runs without a database or a mock, and the
assertion that `generationService.RENEWABLE_MW_SUM` really is built from its
column list lives in `generationService.test.ts`, which already mocks that
connection),
`server/src/services/loadForecastBasis.ts` (ABL-501 added the series half —
`classifyForecastSeriesBasis` and `withholdDivergentBasisSeries`, which
withhold a forecast series rather than a measure derived from one, carry the
chart-worded `seriesReason` rather than `reason`, and take no model argument
because the finding is a property of the country's realized series; ABL-493
widened it to a second carrier shape — the cross-country entry, which publishes `bias` and a skill
block and no `mape` — so the suppressed set is now the named `ERROR_MEASURES`
list rather than four assignments, and `MeasuresClassified<T>` asserts at each
served type's definition site that every numeric field on it is classified),
`client/src/components/comparison/basisNotice.ts` (ABL-493 — the words a
withheld cell shows and the footnote that carries the registry sentence; pure
so "not comparable, never no data" can be pinned without a DOM),
`client/src/components/dashboard/forecastBasisNote.ts` (ABL-501 — the same job
for a withheld chart *overlay*: the legend key, the per-model grouping and the
predicate that keeps a withheld model out of `forecastGap.ts`'s "has no
forecast for <country>" copy. Two modules rather than one because the server
sends a differently worded sentence for a series than for a measure, and the
two surfaces put different evidence in front of the reader),
`server/src/v1/security/requestTarget.ts` (ABL-530 — the closed table of `/v1`
path templates a refused request is classified against, so a caller-controlled
path never reaches the record; its test also rebuilds the table from the route
files as text, so a route added to `v1/routes/` and not added here is a failure
rather than a column that quietly stops distinguishing anything),
`server/src/v1/security/securityReport.ts` (ABL-530 — what the four breach
signals *mean*. Pure so the verdicts can be driven without a database, which
matters here because most of what it asserts is a **refusal to conclude**:
three of the four turn on a distinction a naive implementation collapses —
"we no longer remember" read as "never seen from here", "no baseline" read as a
breadth of zero — and each collapse produces the most alarming reading
available),
`server/src/services/wape.ts` (ABL-388 — the single WAPE definition, moved
out of `crossCountryMetricsService.ts` when `tsoForecastService` and
`mlForecastService` became its second and third callers; its test needed a
fixture database built before it could import a piece of arithmetic, and now
imports no DB-touching module at all),
`server/src/services/actualsSource.ts` (ABL-399 — the single forecast-type ->
actuals mapping, replacing a private copy in each of `forecastService`,
`mlForecastService` and `crossCountryMetricsService`; it emits SQL text and
touches no connection, so its test asserts the shape of the generated
expression — including that no type resolves to the frozen `energy_renewable`,
which is the one assertion that would catch this whole migration being undone),
`lib/divergingStack.ts`,
`dashboard/generationSeries.ts`, `lib/priceWindow.ts`,
`server/src/services/freshness.ts`, `layout/freshnessPill.ts`,
`lib/forecastGap.ts`, `dashboard/forecastLineTokens.ts`,
`lib/multiForecastSeries.ts`,
`lib/netPositionScope.ts`, `lib/coreNetPositionSeries.ts`,
`components/map/netPositionMapScope.ts`,
`components/dashboard/coreNetPositionNote.ts` (ABL-234 — the last two exist as
pure modules for the reason `comparison/mapFill.ts` does: `<Geographies>`
fetches its topojson, so the map's Core/out-of-scope decision cannot be
asserted through the component),
`server/src/docs/claudeMdCitations.ts`, `server/src/release/unmergedWork.ts`,
`server/src/release/publishState.ts` (ABL-311 — the caller hands it two
integers from one `git rev-list --left-right --count`, so every publish verdict
is asserted without a repo, a remote or a network),
`server/src/release/strandedWork.ts` (ABL-498 — the same shape one gate over:
the caller hands it the branch list, the `git cherry` counts and the
`git diff --numstat` blocks, so the phantom-vs-real split, the fold-by-tip and
the numstat parse are all pinned without a repo. Its fixture is measured from
the real checkout on 2026-08-20 rather than invented, because the gate's whole
claim is that it separates six real branches from five phantoms and a
made-up split would prove nothing),
`server/src/services/freshnessRollup.ts`, `server/src/services/hostMetrics.ts`
(ABL-237 — both injectable at their I/O boundary, `statfs`/`loadavg`/`platform`
as optional params, specifically so `hostMetrics.test.ts` can exercise the
graceful-degradation path — a throwing stat call, a mocked Windows platform —
without a real disk or `os.loadavg()`),
`server/src/services/ingestLog.ts` and
`client/src/components/layout/lastRefreshed.ts` (ABL-295 — the pipeline→stream
map and delivery classification on one side, every user-facing word on the
other; the client half is pure so the copy can be pinned without a clock or a
DOM, which is what stops a "Last refreshed" time appearing for a stream that
has never received one).
Logic is extracted into a pure function
specifically so it can be tested this way. `timestamp.test.ts` also drives a
throwaway in-memory SQLite holding both separator forms, and asserts the query
*plan* still shows a range seek — the correctness and the performance property
are both easy to break and neither is visible by reading.

**Routes get an end-to-end test against a fixture database.**
`server/src/routes/*.test.ts` for `dashboard`, `forecast`, `forecastComparison`,
`tsoForecast`, `crossCountryComparison`, `netPosition`, `load`, `generation`,
`prices`, `renewables`, `dataFreshness` and `opsStatus`: a real request in, the real
`ApiResponse<T>` envelope out. Two shared pieces:

- `server/src/test/fixtureDb.ts` — an **in-memory** SQLite database. Its
  `CREATE TABLE` statements are copied verbatim from `energy_dashboard.db`
  because the column defaults are what is under test: `energy_generation` has no
  `DEFAULT 0`, `energy_renewable` does.
- `server/src/test/apiHarness.ts` — starts the **real** app (`createApp()`, in
  its API-only mode) on an ephemeral port. It used to hand-mirror the wiring
  instead, under a comment claiming it matched `index.ts`. It did not, and that
  gap was ABL-13: the shipped app dropped both error handlers whenever
  `client/dist` existed, while every route test asserted against a copy that
  kept them. Do not reintroduce a second app graph here.

**The app wiring gets its own test.** `server/src/app.test.ts` boots
`createApp` in **both** modes — with a real built-client directory written to a
`mkdtemp` dir, and without one — and asserts the error contract from the
outside: content type, status, and the exact `{ success, error, code }` keys.
The SPA-mode half cannot live in `apiHarness.ts`, because it needs an
`index.html` on disk that no route test should have to arrange.

A route test mocks `../config/database.js` to the fixture and
`../config/writeDatabase.js` to `noWriteDb.ts`'s thrower, so **the real shared
database is never opened — not readonly, not writable.** That is structural, not
a convention someone has to remember. Call `clearResponseCache()` in
`beforeEach`: `cacheMiddleware` is a module singleton keyed on URL, and without
it a broken route keeps returning the correct cached answer.

The fixture's six countries each stand for a failure shape this repo has shipped
a wrong number for — `PT` all-NULL generation **plus MK's and SI's live
impossible-zero `energy_load` shape** (exact `0.0` hours *interleaved with real
ones* on the day after `WINDOW`, paired against a flat catboost forecast so the
accuracy half is covered too - ABL-35), `AT` no generation rows *and*
xgboost-only coverage, `BE` negative day-ahead prices plus all-zero solar
actuals, `FR` pumped storage and consumption-only fossil going negative **plus
the two-column hydro shape** (`hydro_run_mw` + `hydro_reservoir_mw`, with the
02:00 reservoir reading NULL so `NULL + 40` staying NULL is asserted rather than
assumed - ABL-17), `GR` stopped publishing mid-window **and carries both
degenerate net-position series**: a forecast collapsed to ~1e-7 MW where no row
is exactly `0.0` so an `= 0` guard misses all of them (ABL-25), and, on the day
after `WINDOW`, actuals that are *exactly* `0.0` (ABL-35) - two defects with one
signature and different guards. GR's `energy_load` on that same day is all-zero
too, which is what pins the fallback: "latest load" has to step back over the
whole bad day to the last hour GR really published rather than reading 0 MW or
dropping the country. `DE`
the ordinary case plus a superseded forecast vintage that catches a broken
`MAX(generated_at)` dedup. Add to that set rather than inventing a seventh
country for a shape already covered — ABL-25 did exactly that, giving GR its
second shape rather than a new country, because "nothing publishes actuals to
contradict the forecast" is the same country's condition.

One format difference the fixture encodes on purpose: `forecasts.target_timestamp_utc`
is written with a **`T`** separator (`atT`), matching production, while the
actuals tables use a space (`at`). That is not cosmetic — `normalizeTimestamp`
converts query bounds to the space form, and `'T'` > `' '` as a string, so a
range predicate on `forecasts` silently excludes the window's end date. See
ABL-21; do not "tidy" the fixture into one format, or the bug becomes untestable.

One thing the fixture deliberately **cannot** express: anything measured
against the real clock. Every row in it is dated 2026-07-01/02, which is in the
past for any run after that date, so a shape that is only wrong when a timestamp
is in the *future* — or one whose whole subject is age — needs rows stamped from
`Date.now()`. `routes/prices.test.ts` (tomorrow's day-ahead prices) and
`routes/dataFreshness.test.ts` (a live stream and a 20-hour-old one) are the
only tests that add any, and both add them to their own copy of the fixture
rather than to `fixtureDb.ts` — a fixed constant would go stale, and a relative
one in the shared builder would silently move every other file's window.

The flip side is useful: because the shared rows are permanently older than
`MEASURED_STALE_AFTER_HOURS`, "stale" is the default in `dataFreshness.test.ts`
and every live case has to be created on purpose. Assertions there are also
written to hold at **every hour of the day** — the day-ahead coverage rule
changes what it requires at 14:00 UTC, and a test that flipped verdict at
lunchtime would be worse than no test.

### This file's own citations are tested

The ~60 `file:line` citations below are checked mechanically by
`server/src/docs/claudeMdCitations.test.ts`, so `cd server && npx vitest run`
fails on a stale one. They rot silently otherwise: an unrelated commit inserts
twenty lines, the cited line still exists, nothing errors, and the citation now
points at a blank line or the wrong function. ABL-3 verified every citation by
hand and a merge the same hour re-broke thirteen of them — hand verification does
not survive concurrent work.

Two rules, both chosen by measuring them against this document (ABL-15):

- **The cited line must exist and hold something.** Not past the end of the
  file, not blank, not comment-only.
- **The symbol must be where the citation says.** When the prose names a symbol
  just before the citation, and that symbol is declared at the top level of the
  cited file, the cited line has to mention it or fall inside its declaration.

The second rule is the one that earns its keep: of the eight stale citations
this check found on arrival, the first rule caught three and the second caught
seven. It is deliberately narrow — skipped for bare `:NNN` continuations, which
idiomatically point at a *use* site rather than at the declaration
(`TABS_WITH_MODEL_PICKER` is declared at `CountryDashboardView.tsx:69` and
applied at `:129`), and skipped when the named symbol is not a top-level
declaration (`ENERGY_DB_PATH` is only ever read off `process.env`, so a citation
naming it is not judged). Both exclusions were needed to reach zero false
positives across the whole file. A check that cries wolf gets disabled.

Notes for when it fails:

- A citation may point at a **comment on purpose**, where the prose quotes the
  comment as a comment. Add it to `COMMENT_CITATION_ALLOWLIST`. Entries are keyed
  by file and by an excerpt of the comment, not by line, so they survive the
  comment moving; an entry that matches nothing is itself a failure, so the
  allowlist cannot quietly accumulate dead weight.
- Citations into the sibling `../energy-data-gathering` module are checked for
  **presence only** — its line numbers are not ours to keep true. They resolve
  against the primary checkout, so they work from a git worktree, and are skipped
  entirely where that module is not checked out.
- The working tree is the source of truth, so editing this file and running the
  suite tells you straight away. Set `CLAUDE_MD_CITATIONS_REF=HEAD` to check a
  committed snapshot instead — worth doing in the primary checkout, where another
  run's half-finished edit to a cited file shifts lines under you. Any ref works,
  so `CLAUDE_MD_CITATIONS_REF=main` answers "is this failure mine, or did I
  inherit it?" without stashing anything.
- **Do not write a port as a backticked `` `:NNN` ``.** That is the bare
  continuation form above, so the checker looks for a file named before it,
  finds none, and fails. Write "port 5173", or attach it to a host. This is not
  hypothetical: ABL-367 shipped ``serves 200 on `:5173` `` to `main` and took the
  whole server suite red until ABL-351 merged, because a citation failure looks
  like a docs nit and a red baseline is how a real regression gets waved through.
  The checker was deliberately **not** loosened to tolerate port-shaped text —
  bare `:NNN` is a supported citation form used ~30 times in this file, and
  widening it to keep one port legal would blind it to every genuine orphan.

What it does **not** catch: a citation that lands on plausible but unrelated
code, where the prose names no symbol. Line numbers stay in the doc because they
are what make it fast to use; this check is the maintenance cost that buys them.
