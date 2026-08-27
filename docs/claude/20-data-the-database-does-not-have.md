> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# Data the database does not have

## Data the database does not have

- **Timestamps that are all really UTC.** 26,405 rows carry a trailing offset
  instead of a bare instant — `2025-11-28T00:00:00+02:00`, length 25 rather
  than 19 — in `energy_price` (6,942), `energy_load` (11,717) and
  `energy_renewable` (7,746). All of them fall in one band, 2025-11-13 to
  2025-11-28, around the same ingest change that produced the separator cutover
  above. A `+02:00` row is displayed two hours from where it belongs. This is
  the sibling module's ingest, not ours; do not "fix" it here and do not
  backfill it. Escalated under ABL-21.
- **Nothing, for generation — except Albania (historical gap, now resolved).**
  This entry used to say nuclear and fossil were unavailable. They are not:
  `energy_generation` holds the complete ENTSO-E A75 document — nuclear, all
  seven fossil sub-types (gas, hard coal, brown coal, oil, oil shale, peat,
  coal-derived gas), waste, pumped storage and battery storage, ENTSO-E's own
  unclassified "Other", and the renewables — 21 `*_mw` columns. Measured
  2026-08-04 against the replica: all 34 countries present, 33 of them spanning
  2021-01-01 → now. **AL** had a gap (672 rows, 2026-05-26 → 2026-06-23, then
  nothing through 2026-08-05) — an *upstream publication* gap, not an
  unfinished backfill; `energy_renewable` held exactly the same 672 rows.
  **Albania resumed publishing A75 on 2026-08-06** (confirmed prod read,
  2026-08-14): `energy_generation` AL now spans through 2026-08-12 21:00 UTC,
  with complete 24-row days from 08-06 onward. The closed gap
  (2026-06-24 – 2026-08-05, ~6 weeks) was an upstream publication outage; the
  stream is alive. `energy_renewable` mirrors it exactly — same 246 new rows,
  same day-by-day pattern. *Note: "It will never fill" and "publishes no A75
  document at all" were written on 2026-08-06/07 right across the resumption
  boundary and were false from that moment.*
- **AL load outage 2026-08-06 – ~2026-08-11, resolved and fully backfilled**
  (ABL-84, ABL-152). AL does normally publish `energy_load`; it stalled
  upstream at `2026-08-06 21:45 UTC` and remained frozen through at least
  2026-08-11. **Measured prod 2026-08-14:** `energy_load` AL spans
  `2026-08-05 00:00 → 2026-08-14 00:30` (867 rows, 96 rows/day = complete
  15-minute coverage); `/api/data-freshness/AL` → `load.latest 2026-08-14
  00:30`, `ageHours 5.2`, `status live`. The hole backfilled completely.
  **Upstream probe findings (ABL-84):** ENTSO-E `A65`/`processType=A16` ended
  at `2026-08-06T22:00Z` exactly (our newest row at the time). Control
  `A65`/`A01` (day-ahead load forecast) returned 94 points through 2026-08-09,
  confirming the token, domain `10YAL-KESH-----5`, and endpoint were all
  healthy. ABL-152 re-probed 2026-08-10: 327 rows, newest still
  `2026-08-06 21:45`, zero transport errors. The outage was purely upstream.
  **The `cron_update.log` 400/503 lines are a trap** (ABL-84): `cron_update.log`
  showed sporadic errors against AL load on 08-06 13:30, 08-08 00:30, 08-09
  00:30. They were not the cause — passes on either side succeeded and
  `MAX(timestamp_utc)` never moved. Do not re-diagnose from error lines alone;
  it produces a confident, wrong answer. This trap warning still applies to any
  future AL load stall.
  What *is* routinely absent is a **production type a given country never
  reports**: that is `NULL`, per column, and must stay NULL rather than become
  0. Measured, `nuclear_mw` is reported by 14 of 34 countries and `marine_mw`
  by 2, against 33 for `wind_onshore_mw` — a country showing `—` for Nuclear
  is normal, not a bug. See "Generation data" below for the NULL/0 and sign
  rules, and `dashboard/generationSeries.ts` for how the columns reach the UI.
- **MK `energy_generation`, stalled upstream since 2026-08-05 21:00 UTC**
  (ABL-451; prior confirmations ABL-112, ABL-152). MK `energy_generation` is
  frozen at `2026-08-05 21:00` — prod `MAX(timestamp_utc)` matches the ENTSO-E
  upstream max exactly. **Confirmed upstream three times:**
  - 2026-08-07: prod DB vs. live pipeline probe — identical timestamp.
  - 2026-08-10 (ABL-152): raw re-probe, newest still `2026-08-05 21:00`.
  - 2026-08-14: raw-HTTP ENTSO-E probe — MK A75 upstream max = `2026-08-05
    21:00`. Controls: BG A75 → `2026-08-13 19:00`, MK A65 → `2026-08-12
    21:00`. Neither the query shape nor the MK domain is at fault; the
    upstream document simply ends there.
  **This is intermittent, not permanent.** MK is a chronically-late Balkan
  zone that will re-enter live on its own — do not group with GB
  (`2021-06-14`) or UA (`2022-02-25`), which are dead outright.
  **ABL-115** (*"Restore MK ENTSO-E actual load, price, and generation
  coverage"*) is **cancelled** — source coverage is a settled Board question.
  **Re-file rule:** a stall at `2026-08-05 21:00` is known; if the cutoff
  *moves and re-freezes at a new timestamp*, that is a genuinely new upstream
  fact worth filing. **A confirmed-upstream cutoff earns a registry entry here
  only once it survives past the rolling 7-day refetch window** (ABL-85: a gap
  that slides out of the window can never self-heal, so the stall is permanent
  until upstream resumes). Before that threshold, confirmation lives on the
  issue, not in this file — an entry written across the resumption boundary
  becomes wrong the moment the zone heals, as happened with AL generation.
- **A real publication time.** `publication_timestamp_utc` exists on eight
  tables and **does not mean what its name says**. It is filled from the ENTSO-E
  response's `createdDateTime`, but ENTSO-E builds the document *on request* and
  stamps it with the generation time — so the column records **when we fetched**,
  not when the value was published. Measured: a Belgian day-ahead price for
  21:45 tonight (published ~12:45 CET yesterday) carries a
  `publication_timestamp_utc` of 06:32 this morning, which is when the cron ran.
  Nothing in the client renders it, so it is not currently lying to a user — but
  do not build on it, and do not backfill it. A historical backfill re-queries
  the API and therefore stamps every row with the date the backfill ran, which
  is worse than the NULL it replaces. If you need "was this published as
  day-ahead or observed after the fact", derive it from the target timestamp
  relative to fetch time, or from `forecasts.horizon_hours` — not from this
  column.

  Non-null counts, measured 2026-08-05 — **13,619,060** in total, not the
  ~4.9M this entry used to claim (that figure covers only the three tables it
  happened to name):

  | table | non-null | rows |
  |---|---|---|
  | `energy_generation` | 3,160,657 | 3,160,657 |
  | `energy_generation_forecast` | 3,033,167 | 3,033,167 |
  | `energy_load` | 2,746,776 | 2,760,216 |
  | `energy_load_forecast` | 2,430,020 | 2,430,020 |
  | `energy_price` | 1,430,549 | 1,530,298 |
  | `energy_renewable` | 811,955 | 811,955 |
  | `net_position` | 5,936 | 644,658 |
  | `crossborder_flows` | 0 | 3,540,460 |

  **`net_position` is no longer fully NULL, and this doc used to say it was.**
  As of 2026-08-05 it carries 5,936 stamps — every one written on or after
  2026-07-31 13:31, for target timestamps from 2026-07-24 onward, i.e. exactly
  the cron-run-time pathology described above. The writer is the sibling
  module (`../energy-data-gathering/src/db.py:1096-1109`), not this repo: our
  own net-position ingest route writes `forecasts`/`forecast_quantiles`
  (`netPositionIngestService.ts:72`, `:78`), never `net_position`. Escalated to
  the CEO under ABL-3 — do not treat "net_position is a clean NULL" as an
  invariant you can rely on. `crossborder_flows` still is.
- **LU's `net_position` was a byte-identical duplicate of DE, until
  2026-08-11.** Both country codes resolve to the same ENTSO-E bidding zone —
  `NET_POSITION_BIDDING_ZONES` maps `DE` and `LU` both to `DE_LU`
  (`../energy-data-gathering/src/entsoe_client.py:1989-1992`) — so every ingest
  pass wrote a separate `LU` fetch that was numerically identical to the `DE`
  fetch, double-counting DE in any per-country aggregate that summed across
  countries (a national total, a cross-country mean). ABL-35 defect 4; fixed
  under Board confirmation `820fa10c` (accepted 2026-08-11): the ingest now
  skips the `LU` fetch entirely, before any API call, rather than fetching and
  deduping after the fact — `NET_POSITION_DUPLICATE_ZONE_COUNTRIES`
  (`../energy-data-gathering/src/entsoe_client.py:1994-2013`), applied at
  `../energy-data-gathering/src/fetch_net_position.py:41-49`. No schema or UI
  change: the dashboard already reads LU through a `LU -> DE_LU` alias, not as
  a second country's series. The **459 rows already stored** under
  `country_code='LU'` (as of 2026-08-10) are deliberately left in place.
  **ABL-67 is now `done`, but do not read that as covering LU.** It
  authorized only the deletion of the 216 GR/IE rows documented above under
  ABL-181 (executed 2026-08-11 13:23 UTC) — rows with no genuine counterpart,
  fabricated outright by a sparse-document forward-fill. LU's rows are the
  opposite shape: real, correctly-fetched measurements that happen to
  duplicate DE's, and were never in ABL-181's scope. Whether to delete a
  genuine duplicate is a different, still-open database-write policy
  question, not settled by this fix. This is `net_position`-only:
  `PRICE_BIDDING_ZONES` carries the identical `DE`/`LU` → `DE_LU` mapping
  (`../energy-data-gathering/src/entsoe_client.py:2017-2022`) and must **not**
  get the same treatment — a price is intensive, not additive, so LU
  genuinely trades at the DE-LU price and de-duplicating it would delete a
  correct value, not a manufactured one.
- **Uniform freshness across zones.** Every actuals table is a mirror of what
  each TSO publishes *when it publishes it*, so "country X is N hours behind
  country Y" is normally upstream cadence, not a broken ingest. The cron
  (`30 0,6,13,18` in the `energy-data-gathering` container) refetches a rolling
  **7-day** window every run and upserts everything it gets, so any hole inside
  that window self-heals as soon as the TSO fills it — and a hole that persists
  across several runs is a hole upstream. Measured 2026-08-07 05:43 UTC, prod
  DB vs. a live probe with the pipeline's own client: MK `energy_load` newest
  `2026-08-05 21:00` in both, MK `energy_generation` newest `2026-08-05 21:00`
  in both, AL `energy_load` newest `2026-08-06 21:45` in both — identical
  timestamp for timestamp, including MK's two interior gaps (25h and 49h). The
  small Balkan zones are chronically late and holey: MK `energy_load` has rows
  on 30 of the 46 UTC dates from 2026-06-23 to 2026-08-07, including a 7-day
  hole 07-07 → 07-13, against 45 of 45 for DE. Two zones are dead outright —
  GB stops at `2021-06-14` and UA at `2022-02-25`. **Before filing a
  "table X is stale for country Y" bug, probe upstream**, and judge freshness
  by `MAX(timestamp_utc)` on prod, never by `data_ingestion_log`. If your
  remit is read-only (no ENTSO-E API access to probe), a frozen
  `MAX(timestamp_utc)` has three possible causes that cannot be separated
  without a live upstream probe: (a) **between passes** — the cron runs at
  `30 0,6,13,18` UTC, up to ~7h apart, so a freeze younger than one pass
  interval is ordinary and not reportable until it survives the next scheduled
  pass; (b) **ingest error** — the pass ran but wrote nothing, which
  `data_ingestion_log` cannot distinguish from a healthy rewrite (see below);
  (c) **upstream stopped publishing.** The honest read-only disposition is
  *"frozen, cause not yet determined; upstream probe required before filing."*
  Check other streams for the same zone first: if `energy_load` and
  `energy_generation` are both frozen at the same timestamp it is *more likely*
  upstream, but still not certain — two pipelines share one cron pass and both
  fail together when a pass errors. **First, grep this file** —
  `grep "2026-XX-XX HH:MM" CLAUDE.md` with your frozen timestamp — because
  the known-gap entries above record every confirmed upstream outage with its
  exact cutoff; a hit means the condition is already on file and you can stop.
  Only if the grep returns nothing should you fall back to closed-issue
  archaeology (searching issue titles and bodies for the same frozen timestamp).
  `data_ingestion_log` records an `INSERT OR REPLACE` rowcount, so rewriting
  rows that already existed logs as inserts and a healthy ingest looks identical
  to a five-day upstream stall.

  **The 21:00 UTC local-day boundary is a distinct upstream signature** (ABL-551).
  Balkan and CET zones (AL, MK, BA, ME, RS) whose local time is CEST (UTC+2) end
  their calendar day at 22:00 local = 21:59 last market hour = `21:00:00` UTC.
  ENTSO-E publishes one row per hour; a stream that ran fully through its last
  local day and then stopped will have exactly 22 rows on the terminal date
  (hours 00–21 UTC), not 24. Two consequences: (a) two zones/streams "stopping
  at the exact same timestamp" means only the same *calendar date* — it is not
  evidence of a shared cause; (b) a clean unbroken run to a local-day boundary
  is the **upstream publication stopped** signature, whereas a real ingest break
  cuts at an arbitrary hour mid-pass.

  **Re-confirmed by direct measurement under ABL-295, and it is AL load.**
  Measured on the replica 2026-08-12: AL's `energy_load`
  `MAX(timestamp_utc)` has been frozen at `2026-08-06 21:45` since the stall
  above, and *every* pass since reports rows stored — 660, 636, 608, 588, 564,
  ... 180, falling monotonically as the rolling 7-day window slides forward
  past the frozen data. So a non-zero `records_inserted` is proof the pipeline
  ran and wrote, and proof of nothing else. (`records_updated`, which would
  separate a rewrite from a genuine insert, is never set: 0 of 114,983 rows
  carry a non-zero value against 99,138 for `records_inserted`.)

  ABL-295 now **does** read this table — see "Last refreshed per stream" below
  — and is built around exactly this limit rather than in spite of it: it
  reports when a pass ran and when a pass last stored rows, names the field
  `lastStoredRows` rather than `lastNewData`, and its on-screen caption sends
  the reader to the freshness pill for data age. Reading it as a currency
  signal is still wrong; reading it as "did the pipeline run, and did it get
  anything" is what it is for.

  (ABL-60 turned the "is this stream current" half of this into
  a served verdict — see "Data freshness" above. That answers *whether* a stream
  is behind; this bullet is why a given zone being behind is usually not a bug
  to file. The 18h threshold is sized from the measurement above — ME at ~9.2h
  is the slowest genuinely-representative country, the longest ingest gap is 7h,
  and 9.5h–34h all select the same set. AL is *not* representative: it publishes
  in bursts and is `stale` a good fraction of the time by design — see "That
  9.4h was a snapshot" above. **Do not retune the threshold to silence AL.**)
- **Forecast horizons beyond ~D+2.** `forecasts.horizon_hours` runs roughly
  2-64h depending on model — there is no stored forecast for D+3 and beyond.
  Re-measured 2026-08-05: catboost 2-63h, xgboost 2-64h, chronos-2-V010 40-64h
  (the three registered ml models); the unregistered/stale ones sit inside that
  envelope too (chronos-bolt-small 1-60h, lightgbm 4-54h, tso_raw and
  tso_corrected 24-46h). `ForecastTab`'s error-by-horizon
  bars only ever render measured `ML D+1` (0-30h), `ML D+2` (24-54h), `TSO
  D+1`, and `TSO D+7`; a previous version multiplied the measured D+1 error by
  fixed factors to fabricate D+3/D+5/D+7 bars, which is why they were removed
  rather than kept.
- **As-issued forecast vintages — added under ABL-184, server-only, and only
  once deployed.** Until now none of the above existed for forecasts either:
  `forecasts` and the two TSO tables are replace-on-refresh, so a corrected
  re-run destroys the value it replaces before anything reads it
  (`ingestNetPositionForecast`'s delete-then-reinsert in
  `netPositionIngestService.ts` is the in-repo example; the TSO tables'
  unique constraint carries no run/issue-time dimension at all, so *any*
  refresh overwrites — ABL-134).
  `server/src/services/forecastVintageArchiveService.ts` now records every
  distinct (source, forecast_type, country, target, model, run, value) tuple
  it sees, the first time it sees it, into a new append-only
  `forecast_vintage_archive` table alongside the existing ones — never
  replacing, never deleting.

  **The migration, exactly:** `ensureForecastVintageArchiveTable`
  (`forecastVintageArchiveService.ts:116`) issues only `CREATE TABLE IF NOT
  EXISTS` plus two `CREATE INDEX IF NOT EXISTS` statements. No existing
  table, column or row is read for writing, altered, or dropped, and there is
  no separate migration script — the table is created lazily by the first
  capture, not by a deploy-time step. No client change, no registry change,
  no reader touched.

  **It captures nothing until this server is deployed and running with a
  write connection** — but that condition is now **met on prod, so query the
  archive rather than assuming it is empty** (ABL-278). Landing this branch
  on `main` changes no running process; `forecast_vintage_archive` does not
  exist in production until code built from it is deployed. Once it is,
  capture is automatic and gated exactly like `POST /api/weather/snapshot`
  already is — on `HELIO_WRITE_TOKEN` being set
  (`shouldScheduleForecastVintageArchive`,
  `forecastVintageArchiveScheduler.ts:50`), started from `index.ts` at
  server boot. If that variable is unset in production for some other
  reason, deploying this code still captures nothing until it is set.

  Verified live on prod 2026-08-12: `HELIO_WRITE_TOKEN` is set, the container
  logs "Forecast vintage archive scheduler: HELIO_WRITE_TOKEN is set;
  capturing every 15m", and the table holds **13,858,301 rows** with
  `first_seen_at` from `2026-08-11T15:24:21Z`. Incremental growth is ~100k
  rows/day, most of it redundant: a refetch that carries an unchanged value
  under a bumped `publication_timestamp_utc` is a new identity tuple, so it
  lands as a new vintage row (see the IDENTITY / DEDUPE KEY note in
  `forecastVintageArchiveService.ts`'s header). That is the design working as
  specified, not a defect, but it is why "more than one vintage" must never
  be read as "the value changed" — count `DISTINCT forecast_value`.

  **What it has already proved (ABL-278).** ENTSO-E day-ahead forecasts are
  revised, and the two TSO tables' overwrite really does destroy the
  as-issued value: over 27,844 observed refetch events, **21.2% of
  pre-delivery refetches and 1.8% of refetches in the first 24h after
  delivery changed the stored value**, while 24-48h after (3,984 events) and
  48h-7d after (19,890 events) changed **zero**. So the value freezes ~24-36h
  past delivery and the remaining ~5 days of the rolling 7-day refetch window
  are pure churn. TSO accuracy read from these tables is measured against the
  revised value, not the as-issued one, and is optimistically biased —
  measured at **11.3% relative** on target day 2026-08-12 (WAPE 2.0849% ->
  1.8485%, n=389), a lower bound. See ABL-278 for the full evidence; the fix
  is scoped separately.

  **Runs in a worker thread, never on Express's request-handling thread.**
  Measured against a full copy of the production-scale replica (2026-08-11):
  one capture pass over `forecasts` (2.1M rows), `energy_load_forecast`
  (2.4M) and `energy_generation_forecast` (3.0M) takes **~147s**, and even a
  fully idempotent no-op rescan of unchanged data takes **~23s**.
  better-sqlite3 is synchronous, so running that inside the process serving
  dashboard API requests would freeze every other response for the
  duration — the same class of problem `services/readQueryWorker.ts` already
  exists to avoid for a single expensive read. `startForecastVintageArchiveScheduler`
  (`forecastVintageArchiveScheduler.ts:104`) instead runs it on a 15-minute
  timer inside `workers/captureForecastVintagesWorker.ts`, on its own
  connection, with an in-flight guard so a slow pass is skipped rather than
  overlapped by the next tick.

- **Core CCR net position (JAO) — added under ABL-230, server-only, and only
  once explicitly enabled.** Step 2 of ABL-219 (Board-approved via
  `confirmation:e4484ddc-7dcc-4e96-bb3d-23883577e078:core-netpos-ingest:v3`).
  `net_position.net_position_mw` (see "NetPositionTab" above) is a zone's net
  position over every SDAC-coupled border; the **Core** net position is a
  separately-published, narrower quantity — only exchanges inside the 12-zone
  Core CCR flow-based domain — that can disagree with it, including in sign
  (France 2026-08-09 08:00 UTC: Core -114.9 MW vs the all-borders +1,557.7 MW;
  full evidence in ABL-219's research brief, issue comment `5ba93873`). This
  is the pipeline's **first non-ENTSO-E source**:
  `https://publicationtool.jao.eu/core/api/data/netPos?FromUtc=<iso>&ToUtc=<iso>`,
  public and unauthenticated, 15-minute resolution, verified working
  2026-08-11. Do not call the distinction "AC vs DC" — it is which borders are
  in scope, not conductor type (Germany's Core figure already nets in its
  HVDC links; France's excludes its AC borders to ES/IT).

  Mirrors the `forecast_vintage_archive` pattern directly above rather than
  `netPositionIngestService.ts`: an append-only capture from an external
  source on a timer, not a client-triggered write. `server/src/services/
  coreNetPositionService.ts` owns a new, additive `core_net_position` table
  (`ensureCoreNetPositionTable`, `CREATE TABLE IF NOT EXISTS` only — no
  existing table touched), `jaoCoreNetPositionCapture.ts` fetches and parses
  one window, and `coreNetPositionScheduler.ts` runs that on a 15-minute timer
  inside `workers/captureCoreNetPositionWorker.ts`, on its own writable
  connection, with the same in-flight guard as the forecast archive.

  Only the 12 Core zone `hub_*` fields are stored (`CORE_ZONE_HUB_TO_COUNTRY`,
  `coreNetPositionService.ts`) — the response also carries 2 ALEGrO hubs and 9
  other external/DC virtual hubs Germany's own figure already nets in, and
  none of those is a standalone bidding-zone net position. `hub_DE` is the
  DE_LU zone; it is stored once, under `'DE'`, never duplicated under `'LU'`
  — creating that duplicate is the exact defect ABL-35 (defect 4) already cost
  a dedicated fix to remove from `net_position`. `resolveCoreCountryCode`
  aliases a caller's `'LU'` to `'DE'` at read time, reusing
  `netPositionService.ts`'s `resolveBiddingZone` for the DE/LU mapping itself
  rather than duplicating it.

  **Gated on TWO env vars, not a reuse of `HELIO_WRITE_TOKEN` alone.** That
  token is very plausibly already set in production, since it also gates the
  live weather-snapshot and net-position-forecast write endpoints — reusing
  it here would risk enabling live JAO capture the moment this code deploys,
  which is exactly what ABL-230 says must not happen as a side effect of
  merging. `shouldScheduleCoreNetPositionCapture`
  (`coreNetPositionScheduler.ts`) requires `JAO_CORE_NET_POSITION_ENABLED` — a
  new variable, not set anywhere, not set as part of this change — **and**
  `HELIO_WRITE_TOKEN`, since a writable connection is still the same
  prerequisite `getWriteDb()` has (unopenable on the Windows/Docker-Desktop
  acceptance box). Landing and deploying this code changes nothing in prod
  until both are set, which is a deliberate follow-up step coordinated with
  the CEO, not part of this issue.

  ABL-230 shipped a deliberately provisional read (`{ points }`, one route) on
  the note that the follow-up UI issue owned the real contract. **ABL-234 made
  that revision** — `routes/coreNetPosition.ts` now serves a per-zone series
  whose empty array always names *which* kind of empty it is, plus a `/map`
  route — see "NetPositionTab" above for the shape and for the toggle that
  consumes it. This section stays the reference for the ingest half.
