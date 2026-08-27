> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# A `/v1` forecast artifact nobody signed off is not served

## A `/v1` forecast artifact nobody signed off is not served

ABL-529, the trigger half of ToS §9.3's thirty days' notice. `server/src/v1/modelVersions/`.

**The failure it closes is a notice that never happens, not a late one.**
`PUBLIC_FORECAST_MODELS` is `['catboost', 'xgboost']` — a model **family** — and
`forecastsRepo.ts` echoed `model_name` and never read `model_version`. So
retraining the artifact behind a pair we already serve moved every number a
subscriber receives while the response still said `catboost`. The subscriber
could not see it and **neither could we**. §9.3.1 (Board-confirmed 2026-08-22)
calls that material: *"a request you made yesterday, repeated unchanged today,
would return different forecast values under the same `model` label"*.

It is not hypothetical. Measured on the replica 2026-08-22, **13 of the 74
public (zone, forecast_type, model) triples already hold more than one
`model_version` across history** — FR `load` xgboost went `20251224_172741` →
`20260201_221331`, DE `price` xgboost `20260112_093054` → `20260202_135018`.
Each is an M1 material change that happened with no notice and no record.

**Three parts, and the middle one is the whole design:**

- `acknowledgements.ts` — the checked-in set a human signed. Records, not rows:
  one `note`, one `serve_from`, and every pair it covers. That record *is* the
  ToS §9.3 changelog source.
- `versionGuard.ts` — pure. `createVersionGate(ledger, now)` answers, per
  triple, which `model_version` values may reach a subscriber.
- `servedLedger.ts` — reads the database **unfiltered** and diffs it against the
  ledger. The detector must see what the gate is hiding, or it reports all-clear
  for as long as the guard keeps withholding.

**Four properties are load-bearing:**

- **A triple absent from the ledger serves unfiltered.** §9.3.1: *"beginning to
  serve a combination we did not serve before is not"* material — ruling A1, and
  exactly what **ABL-525's eight new pairs are**. Absence is the exemption
  expressed as data rather than as a flag somebody has to set. The guard
  therefore costs nothing until the first retrain of an existing pair.
- **It withholds; it does not refuse.** The queries filter `model_version`, so
  the previously acknowledged artifact keeps serving and the subscriber gets
  stale-but-honest numbers. ABL-529's own bar: *"a refusal that blanks a country
  is worse than the problem"*.
- **All four reads take the gate**, and `readForecastEdges` is the one that
  matters least obviously. `latest_vintage_at` and `freshness.status` are built
  from it, so leaving it unfiltered would date the *withheld* run over the
  previous artifact's numbers — a series claiming to be current while serving
  something older, a sharper false claim than the silent swap. The inner
  correlated `MAX(generated_at)` carries the filter too, or the equality targets
  a run the outer query then discards and the series develops **holes** instead
  of falling back.
- **The gate is built per request, not per process.** A material acknowledgement
  matures at its `serve_from` instant; a gate resolved at startup would still be
  withholding on day 31 until somebody restarted the server. The cutover is
  automatic and needs no deploy — both versions become servable, and
  `MAX(generated_at)` picks the newer rows.

**`kind: 'correction'` skips the 30 days, and it is a requirement rather than a
loophole.** ToS §9.3.2 permits a fix for values that are *wrong* to serve
immediately; without that path this guard would block the one change §9.3
explicitly lets us ship at once — the live case being the NL gross-basis load
forecast (ABL-501 / ABL-505 / ABL-506). It is exempt from the wait, **not** from
the changelog. `assertLedgerWellFormed` refuses a `material` record whose
`serve_from` is under 30 days after `acknowledged_at`, so the clause is enforced
by the file rather than remembered by whoever edits it.

**The baseline seed says what it is.** 74 triples, measured read-only on
2026-08-22, `kind: 'baseline'` — *nobody reviewed them for materiality*. Seeding
was unavoidable (refusing all 74 blanks the whole forecast surface) and it
grandfathers no breach, because no external key exists and ABL-349 forbids
issuing one, so nothing has ever been published under any of them. Two
measurements make the seed safe rather than assumed: **0 of 2,246,927 public
rows carry a NULL or empty `model_version`**, and **every triple carried exactly
one version at its newest vintage**, so "the version being served" was a single
well-defined value everywhere. `npm run modelversions -- status` re-measures it
and round-trips clean: 74 observed, 74 servable, 0 unacknowledged, exit 0.

```bash
cd server
npm run modelversions -- status     # exit 1 when a served artifact is unsigned
npm run modelversions -- draft --kind material|correction --by "<role>" --note "<text>"
```

`draft` **prints and does not write**. The acknowledgement's value is that a
human read it; a command that edited the ledger would make "acknowledged" mean
"somebody ran a script", which is the state this exists to end. The reviewed
commit is the signature. It sends nothing either — §9.3's channels are the
change log at `/changelog` (ABL-532) and `npm run keys -- keys:contacts`
(ABL-528). See "Serving a changed model artifact: the ToS §9.3 sequence" in
CLAUDE.md for the full sequence.

**Two things it cannot do, stated rather than implied:**

- **A withdrawal cannot be withheld.** §9.3.1's M4 makes it material to stop
  covering a zone a model covered, and a read-side guard has no rows to filter.
  `diffLedger` reports it (`triple_gone`) and nothing enforces it.
- **`/v1/accuracy` is deliberately ungated.** It scores *history*, which is made
  of superseded artifacts by design; filtering it through a ledger that records
  only what may be served **now** would drop every pre-swap sample and make a
  historical figure move when a ledger entry was added. The residual, named: for
  a window reaching the present, an accuracy figure reflects a newly promoted
  artifact while `/v1/forecasts` withholds it. Bounded, not the §9.3.1 failure
  this closes, and closing it needs the ledger to record every historical
  version. Follow-up; do not bolt it on by reusing the serving gate.

**Cost, measured on the replica rather than waved at.** The serving filter adds
nothing per request beyond the SQL — the gate reads static source, no query. The
`IN` clause on the correlated subquery is the real price: DE/load over 7 days
**4.7 ms → 8.4 ms**, and over the 366-day maximum window **105 ms → 186 ms**,
same 5,232 rows either way. `resolveServingModel` got *faster* — it became two
`LIMIT 1` index probes instead of one `DISTINCT` scan, **0.50 ms → 0.08 ms**
worst case. The lever if the 186 ms ever matters is an index carrying
`model_version`, which is a write to a database this repo does not own.

The startup audit in `publicIndex.ts` costs one query, **2.9 s** against the
9.4 GB replica. Note the shape: the obvious correlated `generated_at = (SELECT
MAX(...) ...)` form **timed out past 120 s**, because
`idx_forecasts_model_lookup` carries no `generated_at`. The CTE that computes
the 74 maxima in one index scan and then seeks each triple once is what makes it
a startup cost rather than an impossible one.
