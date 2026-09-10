> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# Common Issues

## Common Issues

**"Cannot connect to database":**
- Verify the SQLite file at `ENERGY_DB_PATH` (or `server/.env`'s value) exists
- Without `ENERGY_DB_PATH` set, the server defaults to `/data/energy_dashboard.db`, which won't exist on a workstation checkout

**The Forecast-accuracy tab shows no MAE/MAPE/RMSE for a country, with a
sentence instead of numbers:**
- That is the signal working. A country whose realized load and load forecast
  are published on different bases has every error measure withheld, because
  their difference is a definitional gap rather than forecast error — see the
  `ForecastTab` entry above. **NL** is the only registered case;
  `services/loadForecastBasis.ts` carries the upstream measurement behind it.
- **The same country now reads "not comparable" on the Forecast quality
  portfolio too** — unranked rather than last, no D-7 loss badge, and a
  footnote naming the reason (ABL-493). Until then the rule had one caller, so
  NL's load error was withheld on the country tab and published in full on
  `/api/cross-country/metrics` at the same moment. If you see the two disagree
  again, that is the shape to look for: the rule lives in
  `loadForecastBasis.ts` and every surface has to route through it.
- **And the Load tab draws no forecast line for that country at all** — the
  same rule applied to the series rather than to a measure (ABL-501). That one
  had the largest blast radius of the three, because it was a picture rather
  than a number: NL's chart drew 9,431 MW over a realized 4,361 MW. See
  `LoadTab` above for the four endpoints that withhold and for why a withheld
  overlay must never borrow the "not available in <country>" copy.
- `dataPoints` stays non-zero on purpose: the points really did pair, and
  reporting zero would claim we hold no data when we hold both series in full.
  The TSO D+1/D+7 horizon bars are absent for the same reason.
- Do not "fix" this by adding a threshold — the distribution has no gap to put
  one in (FR reached 11.6% MAPE through ordinary error). Do not add a registry
  entry for another country without probing the raw ENTSO-E `A65` documents
  first; BA/MK/MD/LT/EE/IE are suspected and unestablished.

**A country's load/price forecast is blank:**
- **First, read the card.** If there is a sentence under the chart saying the
  forecast was withheld, that is the divergent-basis rule working (ABL-501) —
  NL is the only registered case. The rows exist; we are declining to draw
  them, because they forecast Dutch load gross of behind-the-meter solar while
  the realized series is published net of it. `meta.withheldPoints` on
  `/api/forecasts` is non-zero and says how many. Do not "fix" it by removing
  the rule, and do not file it as missing data.
- Check whether a specific model is checked in `ModelPicker` — catboost and
  xgboost coverage barely overlaps (see Forecast model selection), so a
  checked model with no data for that country renders nothing for that line.
- With nothing checked ("Default"), an empty overlay is silent: the actuals
  still render, there is just no dashed line and no footnote explaining why.
  **This is a deliberate exception to this file's usual "never fill a gap
  silently, say why" rule** (ABL-221) — the single-pin footnote that used to
  read "<model> has no forecast for <country> in this window." with a **Use
  the best available model** button was reported confusing and removed from
  `LoadTab`'s and `PriceTab`'s default views. `describeForecastGap` and the
  `ForecastGap` type it returns still live in `lib/forecastGap.ts` and are
  still exercised — `NetPositionTab` calls `describeForecastGap` directly
  (not through `ForecastGapNotice`) for its own per-model footnote, and that
  one was **not** touched; see the `NetPositionTab` entry above.
- With one or more Load/Price models checked (ABL-204), a checked-but-empty
  model stays in the chart's legend with a hatched key and "— Not available
  in <country>" rather than disappearing, and gets its own footnote below the
  chart with a **Remove from comparison** button
  (`lib/forecastGap.ts`'s `describeForecastGapsForSelection`,
  `ForecastGapNotice`'s `gaps` prop, now the component's only prop — ABL-221
  deleted the single-select `gap` prop and its render branch as dead code
  once `LoadTab`/`PriceTab` stopped passing it). This multi-select case is
  unrelated to the removed default-view footnote above: it only renders once
  a user has explicitly checked more than one model to compare, so ABL-221
  left it in place.
- Selecting the type's **"Default — automatic"** entry clears every checked
  model (ABL-16). It used to *create* a pin, which is what made this state
  unrecoverable without clearing localStorage.
- Confirm the model is actually registered in `server/src/config/forecastModels.ts`

**TSO forecasts not showing:**
- In `ModelPicker`, check a `TSO ·` entry for that forecast type. `load` has
  both D+1 and D+7 registered; `solar`/`wind_onshore`/`wind_offshore` have D+1
  only; `price`/`renewable`/`biomass`/`hydro_total`/`net_position` have no TSO
  model at all — check `forecastModels.ts` before assuming a bug
- Note `ModelPicker` does not render on the Generation, Forecast-accuracy or
  Net position tabs at all (`TABS_WITH_MODEL_PICKER`,
  `CountryDashboardView.tsx:69`, applied at `:129`) — Net position instead
  gets its own separate multi-select `NetPositionModelPicker` — so there is no
  "picker that does nothing" to hit on any of the three
- Check the API response has data for the selected country
- Verify database tables have data: `energy_load_forecast`, `energy_generation_forecast`

**Week-ahead (D+7) band not showing:**
- Check "ENTSO-E TSO · D+7" in `ModelPicker` for the Load tab — there is no
  separate D+1/D+7 toggle anymore, the picker's selection controls it
- With one or more models checked (ABL-204), the band draws only when D+7 is
  the *sole* checked model — several bands on one chart is unreadable, and a
  lone band under N lines would misattribute uncertainty to models that never
  published one. Uncheck the others to see it.
- Verify min/max data exists for that country (week-ahead is daily granularity
  at `T12:00:00Z` timestamps; the band needs `forecast_min_mw`/`forecast_max_mw`)

**Chart not updating:**
- React Query caches data - check `staleTime` settings
- Force refetch with `refetch()` from hook
- Clear localStorage to reset Zustand state

**Time navigation not working:**
- Check `timePreset` and `timeAnchor` in store
- Verify date range calculation in `getDateRangeForPreset()`
  (`useDashboardData.ts:47`) — there is no `useComputedDateRange()`, despite
  what this file claimed until ABL-4
- A preset with no `case` there is a compile error since ABL-12 (`never` guard
  in the `default` branch), so this is caught by `tsc -b` rather than by
  reading — but the `default` still resolves to a 7-day window at runtime, for
  the unvalidated string a same-version persisted blob can carry
- `timeOffset` is non-zero whenever the arrows have been used, and it is in
  ~10 React Query keys — a "stale" chart is often just a shifted window; check
  the explicit range the picker shows beside itself
- Bump `PERSIST_VERSION` and add a `migratePersisted()` clause if you changed
  the shape of anything in `partialize`

**The header pill says "stale" (or "tomorrow missing"):**
- That is the signal working, not a UI bug. Read `/api/data-freshness/:cc` —
  each stream carries `latest`, `ageHours` and `status`, so it names which one
  is behind and by how much.
- `stale` on `load`/`generation` means the newest *measurement* is over 18h old,
  which is past the longest scheduled gap plus the slowest TSO's own lag: at
  least one full ingest pass stored nothing for that country. Settle it on prod
  (`/app/logs/pipeline.log`), not the workstation replica — the replica can be
  hours behind prod even with a fresh mtime.
- `stale` on `price` means the day-ahead result does not reach the market day it
  should. After 14:00 UTC that is tomorrow. This is ABL-51's signature.
- `ended` is not an alarm: the stream was held before but its newest usable row
  is over 30 days old. On the 2026-08-10 fleet this names GB/UA load and
  generation forecasts, plus AL generation. It is derived from age and
  self-clears when a newer row lands; do not replace it with a country list.
- See "Data freshness" above before changing a threshold — all are sized from
  measurements recorded there.

**Data freshness returning nothing:**
- Verify `/api/data-freshness/:countryCode` endpoint is responding
- Check that database has data for selected country — a stream with no rows at
  all reports `status: 'none'`, which is deliberately not `stale`

**A query that filters/joins on `date(timestamp_utc)` or `strftime(...)` is slow:**
- SQLite cannot use an index through a function of the indexed column, so a
  predicate like `date(r.timestamp_utc) = date(l.timestamp_utc)` degrades to a
  full scan of the joined table per row. The old `getRenewablePercentage`
  (`energy_renewable` joined to `energy_load`, since removed - renewable
  share is now `generationService.getRenewableShare`, a join-free ratio of
  window sums over `energy_generation`) hit this: 51s for a 30-day window,
  0.009s after switching to a direct `r.timestamp_utc = l.timestamp_utc`
  equality join. Grouping/formatting output with `date()`/`strftime()` is
  fine — only filtering or joining on a function of the timestamp column
  defeats the index.
- This is why window predicates go through `rangeClause`/`rangeArgs` rather
  than wrapping the column in `REPLACE`: see "Timestamp storage: two separators
  in one column".

**A series is short by exactly one day, at the end of the window:**
- Almost certainly a hand-rolled timestamp bound instead of
  `timestampRange`/`rangeClause`/`rangeArgs`. `'T'` sorts above `' '`, so a
  space-form upper bound excludes every `T`-separated row on the end date — and
  the default window ends at *now*, making the dropped day today. That was
  ABL-21; see "Timestamp storage: two separators in one column".
- The symptom is a missing series with no error and no empty state, which reads
  as "the model didn't run" rather than as a bug. Check the row count against
  raw SQL before believing the chart.

**An API call returns HTML, or `unwrap()` reports a malformed envelope:**
- Fixed under ABL-13, but know the shape, because it is invisible in a dev
  checkout. The server decides it is "production" from the mere existence of
  `client/dist/index.html` (`app.ts`'s `resolveClientDist`), not from
  `NODE_ENV` — so a built or deployed box takes a branch a plain `npm run dev`
  never does. That branch used to skip `notFoundHandler`/`errorHandler`
  entirely, on the belief that the SPA fallback covered them. It did not:
  `app.get('*')` catches unmatched *routes*, never a thrown error, and Express
  selects an error handler by arity. Measured before the fix, in production
  mode: a thrown `AppError` came back `400 text/html` as
  `<pre>Error: …</pre>` plus ten stack frames of absolute repo paths, and an
  unmatched `/api/*` came back **`200` with index.html** — a success status
  carrying HTML into `unwrap()`.
- Both handlers are now registered unconditionally, after the SPA fallback, and
  the fallback skips `/api`. `server/src/app.test.ts` pins all of it; removing
  either half fails it.
- To reproduce this class of bug at all you need `client/dist/index.html` to
  exist — it is gitignored and absent in a fresh checkout, which is why it
  survived. Create one, start the server, and curl an API path.

**Every `/api/...` route returns an HTML 404 from `localhost:3001`:**
- Read the response headers before debugging routes. If the same HTML 404
  appears through Vite and directly on `localhost:3001`, with a `Server:` header
  we never set (observed: `Server: gunicorn`), you are not talking to our server.
  An unmatched `/api` route from our Express app is a JSON
  `{ success, error, code }` envelope with no `Server` header; that response
  contract is pinned in `server/src/app.test.ts:118`.
- Diagnose the listener collision with the port-owner and Docker checks in
  [`../WORKFLOWS.md`](../WORKFLOWS.md), **API proxy on CAT**. On CAT, an
  unrelated service owns loopback `localhost:3001` even while the dashboard
  container publishes the same port on its LAN address; the specific loopback
  bind wins for loopback traffic.
- This is an environment problem, not a repo problem. Do not "fix" it by
  changing the default proxy target in `client/vite.config.ts`. Keep the
  environment-specific acceptance target in the gitignored `.env.local` as
  documented in `WORKFLOWS.md`; use its separate `PORT=3002` procedure for a
  working-tree server. After editing this file, `cd server && npx vitest run`
  checks its `file:line` citations via `docs/claudeMdCitations.test.ts`.

## `attempt to write a readonly database` inside the CAT container (ABL-657)

**Symptom.** The acceptance container logs `Error: attempt to write a readonly
database` in bursts — 172 of them between 2026-08-28 and 2026-09-03 — and the
ops-status environment badge flaps `ok -> error -> ok` twice a day. ABL-634
aligned every breach against `C:\Code\able\logs\sync-db-v2.log` and found all
of them strictly inside a `Replacing local tables (transactional)` → `Done.`
window, with the one RECOVERED landing 3m01s *after* the `Done.`

**It is not a write.** There is no application write on that request path.
`config/database.ts` opens the handle `{ readonly: true }`, so a write is not
merely absent, it is impossible; `routes/opsStatus.test.ts` already pinned that
`/api/ops/status` performs none. The error is SQLite's pager, and the reason
the two environments disagree about it is lock visibility across the bind
mount.

**Measured 2026-09-03**, one scratch database in a Docker Desktop bind mount,
one Windows-host writer holding an exclusive transaction, two readonly readers
at the same instant:

| reader | `err.code` | `err.message` |
|---|---|---|
| Windows host (`node`, better-sqlite3) | `SQLITE_BUSY` | `database is locked` |
| Linux container over the bind mount | `SQLITE_READONLY_ROLLBACK` | `attempt to write a readonly database` |

The container cannot see the host writer's `RESERVED` lock through the mount,
so `hasHotJournal()` finds a journal file with no lock holder, concludes the
journal is *hot*, and tries to roll it back — a write, on a readonly handle.
Split further: `new Database(path, { readonly: true })` **succeeds**; the throw
comes on the first read, when the shared lock is taken. So the long-lived
handle survives the window and recovers on its own; nothing needs reopening.

**Practical consequence.** `SQLITE_BUSY` and `SQLITE_READONLY_ROLLBACK` are the
same event seen from two sides. Never treat "attempt to write a readonly
database" in a container log as evidence that something wrote, and never go
looking for the write — grep `sync-db-v2.log` for an open transactional window
first.

**Why the badge flapped rather than reading `warn`.** Two independent defects,
both fixed here:

1. `/api/ops/status` threw when its freshness rollup could not read the
   database, and `reachable` is decided by whether that endpoint answers — so a
   live, serving process reported as an unreachable *environment*. The rollup
   now degrades to `unmeasured` with the reason (`freshnessRollup.ts`) and the
   endpoint answers 200.
2. `checkSyncBlackoutWindow` read `now.getHours()` — *this process's* clock —
   against a schedule written in the workstation's wall clock. `docker/Dockerfile`
   sets no `TZ` and `node:20-slim` is `Etc/UTC`, so 16:38 local read as 14:38
   and **neither window ever matched inside the container**. The hold that
   existed to soften exactly this was dead code on the only deployment it was
   written for. It is now evaluated in `SYNC_HOST_TIME_ZONE` via `Intl`,
   verified by running the built `dist` inside a `node:20-slim` container at the
   six real breach instants.
