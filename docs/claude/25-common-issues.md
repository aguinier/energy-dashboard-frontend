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

**`gh auth status` says "not logged into any GitHub hosts" though the
credential is intact (ABL-631, 2026-09-02):**
- **Rule out a revoked/missing token first, then rule it back in.**
  `cmdkey /list | findstr github` shows the Windows Credential Manager entries
  from the ABL-512 `gh auth login` (`LegacyGeneric:target=gh:github.com:aguinier`
  plus a machine-persistence twin) survive untouched. `git` push/fetch stay
  unaffected the whole time — `credential.helper=manager` (Git Credential
  Manager) is a wholly separate store from `gh`'s. A `git push --dry-run
  origin main` that reaches GitHub and comes back an ordinary
  `non-fast-forward` (not `403`, not `could not read Username`) is proof push
  auth is fine; a bare `git fetch` proves nothing about push, so it is the
  dry-run that is the check to repeat, not the fetch.
- **Root cause: the agent-spawned shell is missing `APPDATA`/`LOCALAPPDATA`
  entirely** — confirmed in both bash and PowerShell tool invocations
  (`echo $APPDATA` / `echo $env:APPDATA` both empty), even though
  `%APPDATA%\GitHub CLI\hosts.yml` exists on disk and is current. `gh`
  resolves its config directory from `GH_CONFIG_DIR`, falling back to
  `os.UserConfigDir()` (`%APPDATA%\GitHub CLI` on Windows) — with `APPDATA`
  unset it silently resolves to a directory with no `hosts.yml`, which reads
  identically to "never logged in." Explicitly passing the right directory
  proves the credential path end to end:
  `GH_CONFIG_DIR="C:\Users\<user>\AppData\Roaming\GitHub CLI" gh auth status`
  returns `✓ Logged in ... (keyring)` with real token scopes. `APPDATA`/
  `LOCALAPPDATA` are normally synthesized into an interactive logon session by
  Windows, not stored in `HKCU\Environment` (`reg query HKCU\Environment`
  confirmed neither key is there even for the interactively-authenticated
  user) — whatever spawns the agent's shells does not go through that
  interactive-logon path, so those two variables never arrive.
- **`setx GH_CONFIG_DIR "C:\Users\<user>\AppData\Roaming\GitHub CLI"` only
  reaches a freshly spawned process.** Proven empirically: setting it, then
  checking `$env:GH_CONFIG_DIR` from the very next Bash/PowerShell tool call
  in the *same* agent session, came back empty — the harness's already-running
  shell-spawning process inherited its environment once, at its own startup,
  and does not re-read `HKCU\Environment` per command. Neither shell sources a
  profile file either (`~/.bashrc` / `$PROFILE`): writing a probe variable to
  both and checking a fresh tool-invoked shell never saw it, so a
  profile-based fix is also a dead end for this harness. The `setx` fixes the
  **next** agent session (or the next interactive terminal), not the one
  already open when it was run — it is what makes PowerShell agent shells
  work once this harness process is next restarted.
- **`C:\Users\<user>\bin\gh` is a bash-only shim that closes the gap
  immediately, restart or not**, by setting `GH_CONFIG_DIR` and `exec`ing the
  real `gh.exe`. It works only because `~/bin` resolves before `C:\Program
  Files\GitHub CLI` in bash's `$PATH` (index 1 vs. 48, checked with `echo
  $PATH | tr ':' '\n' | grep -n ...`) — the same trick does **not** shadow the
  real binary for PowerShell, because there `C:\Program Files\GitHub CLI`
  (index 39) resolves before `C:\Users\<user>\bin` (index 45), and that
  index's already-frozen for the running session the same way `GH_CONFIG_DIR`
  is. Do not try to "fix" PowerShell by reordering `PATH` or by shimming
  inside `C:\Program Files\GitHub CLI` itself — that directory is a shared,
  installer-owned location outside repo scope, and reordering the machine/user
  `PATH` via the `setx` CLI risks silent truncation past 1024 characters on a
  `PATH` this long. PowerShell agent shells get fixed by the `setx` above,
  once this harness process restarts.
- **One-command re-diagnosis for a recurrence:** `cmdkey /list | findstr
  github` (is the credential still there?) vs `gh auth status` in the shell
  agents actually use (is `gh` finding it?). If the first shows an entry and
  the second says logged out, check `echo $APPDATA` (bash) / `echo
  $env:APPDATA` (PowerShell) in that same shell — empty confirms this bug
  class, not a revoked token. `reg query HKCU\Environment` shows whether
  `GH_CONFIG_DIR` is still set; re-run the `setx` above if not, and expect it
  to need a fresh session to take effect.
- **Do not** bring back the ABL-512 `settings.json` token workaround (a raw
  PAT embedded in a config file the harness reads directly, bypassing the OS
  keyring). This fix only points `gh` at the config directory that already
  holds its own correct, keyring-backed `hosts.yml` — no credential is
  embedded anywhere in the repo or in agent config.
- This is a workstation/OS environment gap, the same category as the
  Node-version and `node_modules` gotchas in `docs/claude/03-quick-start.md`,
  not an application or repo bug.

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
