# CLAUDE.md - Frontend Module

**Canonical copy rule:** The authoritative version of this file is the one on `origin/main`. Every worktree freezes a local copy at its branch point — that copy drifts silently as corrections land on main. Always fetch the current `origin/main:CLAUDE.md` when onboarding or cross-referencing; never treat a worktree-local copy as current.

This file provides guidance to Claude Code when working with the Energy Dashboard frontend.

## How to maintain this file (ABL-536)

This file auto-loads into every agent context, so its size is a per-turn tax on
the whole fleet. It once grew to 6,700 lines and killed runs outright.

- **Hard budget: 700 lines / 35 KB.** If an edit would cross it, move material
  to `docs/claude/` first. Enforced, not merely asked for: the test below fails
  the suite when this file crosses either limit, and again if this sentence and
  `CLAUDE_MD_BUDGET` stop agreeing. Bytes are counted LF-normalised, as git
  stores the file, so the verdict is the same on every platform. Raising the
  budget to fit an edit is not the remedy — moving the material is.
- **Durable rules only.** Commands, maps, invariants, gotchas — each stated
  once, tersely. Incident narratives, dated measurements, per-issue forensics
  and evidence trails go in the matching `docs/claude/` topic file; append
  there and reference it here in one line if a pointer is warranted.
- **Correct in place.** When a rule changes, rewrite it — never append a
  "this used to say…" paragraph. The history lives in git and in `docs/claude/`.
- **Baselines rot.** Test counts, coverage tables and row counts have a shelf
  life; keep the command that re-measures, not the figure (the tripwire
  absolutes live in `docs/claude/21-testing.md`).
- After editing this file: `cd server && npx vitest run src/docs/claudeMdCitations.test.ts`
  must pass (see Testing below for its rules).

## Project Overview

React + TypeScript web dashboard for visualizing European energy market data:

- **client/** — React 18 SPA (Vite, Tailwind, Recharts, Zustand with versioned
  localStorage persistence, TanStack Query)
- **server/** — Express API (better-sqlite3), reading the SQLite DB shared with
  the `energy-data-gathering` sibling module

**Database schema:** [`../energy-data-gathering/database_structure.md`](../energy-data-gathering/database_structure.md).
**Prod/acceptance runbook:** [`../WORKFLOWS.md`](../WORKFLOWS.md) (deliberately outside this repo).

## Quick Start

```bash
npm install
npm run dev
```

Runs client and server together. The server needs `server/.env` with
`ENERGY_DB_PATH` set (see Database Connection); without it it falls back to
`/data/energy_dashboard.db`, which does not exist on a workstation checkout.

- Frontend: http://localhost:5173
- API server: http://localhost:3001

**Dev-server and node_modules rules** (forensics: `docs/claude/03-quick-start.md`):

- **Never run `npm install`, `npm ci` or `npm rebuild` in this checkout while
  other processes hold it** — this workstation runs ~20 concurrent node
  processes across agent sessions, and rewriting `node_modules` under them
  breaks several at once. Safe: `npm install --dry-run`, `npm ls`, and the
  completeness check below. `npm ci` only into a scratch directory *outside*
  the checkout, with `--ignore-scripts`.
- `Cannot find package '@babel/core'` where the resolved path ends
  `@babel\core\index.js` (not `lib\index.js`) is a **stale dev-server process**
  pinned to a mid-install resolution — restart the dev server, do not install.
  A genuinely missing package reports the bare specifier instead.
- **Check the server half by socket, not by PID** — `tsx watch` idles on after
  its child crashes.
- **Never inherit `PORT` from a Paperclip run** (it is 3100, Paperclip's own
  control plane; the server dies EADDRINUSE). Launch artifact, not a repo bug.
- Dependencies hoist to the repo root under npm workspaces. If
  `node_modules/.bin` is missing, use the entry points directly:
  `node ../node_modules/vitest/vitest.mjs run`,
  `node ../node_modules/typescript/bin/tsc --noEmit` (from `server/` or `client/`).
- **Junction trap:** many worktrees reach the primary `node_modules` through an
  NTFS junction, and `git worktree remove --force` (or any recursive delete)
  walks *through* junctions and deletes the shared target. Drop the junction
  first: `cmd /c rmdir "<worktree>\node_modules"`, then remove the worktree.
- Tree-completeness check (prints `missing packages: 0` on a healthy tree, no
  install needed):

  ```bash
  node -e "const l=require('./package-lock.json'),f=require('fs');let m=0;
  for(const[p,v]of Object.entries(l.packages)){if(!p.includes('node_modules/')||v.link||!v.version)continue;
  if(v.os&&!v.os.includes('win32'))continue;if(v.cpu&&!v.cpu.includes('x64'))continue;
  if(!f.existsSync(p+'/package.json'))m++}console.log('missing packages:',m)"
  ```

  Non-zero calls for the additive donor-copy repair in
  `docs/claude/03-quick-start.md` — still not a licence to `npm install` in place.

## Project Structure

```
energy-dashboard-frontend/
├── client/src/
│   ├── views/                    # MapView (Europe choropleth landing),
│   │                             #   CountryDashboardView (per-country tabs),
│   │                             #   ComparisonView (forecast-quality portfolio)
│   ├── components/
│   │   ├── charts/               # Able* Recharts primitives (line+overlay, stacked mix,
│   │   │                         #   donut, heatmap, accuracy bars, sparkline), ChartWrapper
│   │   ├── dashboard/            # Price/Load/Generation/NetPosition/Forecast/Wind tabs,
│   │   │                         #   ModelPicker, TimePicker, ForecastGapNotice,
│   │   │                         #   ForecastVintageNote, ModelComparisonPanel,
│   │   │                         #   generationSeries.ts + pure helpers (each has .test.ts)
│   │   ├── comparison/           # ComparisonView helpers: accuracyScale, leaderboardRows, mapFill
│   │   ├── map/                  # EuropeMap, MapMetricSelector, NoDataHatch
│   │   ├── layout/               # AbleHeader, freshnessPill
│   │   └── ui/                   # shadcn/radix primitives
│   ├── hooks/                    # useDashboardData (bulk), per-tab batched hooks,
│   │                             #   useForecastModels, useModelComparison
│   ├── services/                 # api.ts (Axios), unwrap.ts (ApiResponse envelope)
│   ├── store/                    # dashboardStore (persisted), migrate.ts (PERSIST_VERSION),
│   │                             #   themeStore
│   ├── types/index.ts
│   └── lib/                      # constants, chartAdapters, dataScale, forecastGap,
│                                 #   timezone, queryRetry, formatters, ...
└── server/src/
    ├── app.ts                    # createApp() — middleware graph, no listen()
    ├── index.ts                  # detects built client, listens
    ├── routes/                   # index.ts mounts everything under /api:
    │                             #   dashboard, load, prices, renewables, generation,
    │                             #   forecast, tsoForecast, forecastComparison,
    │                             #   crossCountryComparison, netPosition(+Ingest),
    │                             #   coreNetPosition, dataFreshness, countries,
    │                             #   weather, opsStatus
    ├── services/                 # one module per route group; pure verdict modules:
    │                             #   freshness, loadQuality, degenerateForecast,
    │                             #   freshnessRollup, hostMetrics, wape, loadForecastBasis;
    │                             #   forecast-vintage + ops-snapshot + JAO capture schedulers
    ├── workers/                  # scheduler write threads
    ├── lib/                      # syncBlackoutWindow, opsStatusThresholds (ONLY home of
    │                             #   ops warn/error cutoffs — consumers get verdicts)
    ├── config/                   # database.ts (readonly), writeDatabase.ts (lazy),
    │                             #   forecastModels.ts (the model registry)
    ├── middleware/               # cache, errorHandler, writeAuth
    ├── utils/timestamp.ts        # normalizeTimestamp + range helpers (see Data semantics)
    ├── docs/                     # claudeMdCitations.ts — checks this file's citations
    ├── v1/                       # the separate public app (see below)
    └── types/
```

## Database Connection

The server reads `ENERGY_DB_PATH` and opens that SQLite file **readonly**
(`server/src/config/database.ts`). For local dev, copy `server/.env.example` to
`server/.env` and set `ENERGY_DB_PATH` to the machine's replica. In
Docker/production it comes from the container; the built bundle does not read
`server/.env`.

**`client/.env.local`'s `API_PROXY_TARGET`** controls where the Vite dev server
proxies `/api` (`client/vite.config.ts`). Unset, it proxies to your local
server on port 3001. On CAT the acceptance target is the local dashboard Docker
container (built image — working-tree server changes are not visible through
it); see [`../WORKFLOWS.md`](../WORKFLOWS.md), **API proxy on CAT**, for the
authoritative target and the separate local-server procedure.

**The workstation replica can be hours behind prod even with a fresh mtime.**
Anything about prod health or freshness must be settled against prod directly
(`http://192.168.86.36:3001/api/...`, read-only). The replica is the right
place to measure *shapes* (row counts, distributions), never currency.

**The replica is locked to all readers twice a day while `able-db-sync` runs**
(`sync-db-v2.ps1`, Scheduled Task at 07:00 and 16:30 local time). The task
rebuilds every non-weather table inside one SQLite transaction, which holds an
exclusive write lock for the duration — currently 30–60 min but variable;
overruns past an hour have been observed. A `database is locked` error on the
workstation replica is planned maintenance, not a hang or a bug; check the
`.db-journal` mtime (advancing = writer still alive) and
`C:\Code\able\logs\sync-db-v2.log` (a `Replacing local tables (transactional)`
line with no later `Done.` means the lock is held right now) before escalating
(ABL-612).

## Deployment

Merging to `main` does **not** deploy — no CI/CD. Production is
**QuietlyConfident** (`ssh clavain@192.168.86.36`), checkout
`/home/clavain/energy-dashboard/repos/energy-dashboard-frontend`, serving on
port 3001. After the reviewed commit reaches GitHub:

```bash
cd /home/clavain/energy-dashboard/repos/energy-dashboard-frontend
git pull && cd docker
docker compose build
docker compose up -d --force-recreate
```

Do not commit code on production. Never infer deployed state from git ancestry
or an issue marked done — inspect the running container and the served bundle.

## The public `/v1` surface

`server/src/v1/` is a **separate Express application** (`createPublicApp`,
`server/src/v1/publicApp.ts:204`, run from `publicIndex.ts`) — not
`createApp()` with routes hidden. It binds loopback by default and **is not
deployed or exposed**; changing the bind address is a Board-level decision.
Full design, key store, metering, quotas, refusal log, billing, OpenAPI drift
check, changelog and model-version gate: `docs/claude/07…16-*.md`.

Invariants:

- The public app **does not import** `routes/index.js`, has no static mount /
  SPA fallback (`publicNotFoundHandler`, `server/src/v1/publicErrors.ts:98` is
  the only catch-all), no body parser, and no `config/writeDatabase.js` — the
  internal handlers are absent from its dependency graph, not filtered.
  `publicApp.test.ts` (behavioural) and `publicAppGraph.test.ts` (structural,
  reads the app as text) both pin this; a `/v1` route that reaches back into
  `routes/`, an ops service or a write handle fails the graph test.
- `HELIO_WRITE_TOKEN`, `JAO_CORE_NET_POSITION_ENABLED`, `OPS_PEER_URL`,
  `COMMIT_SHA` and `PAPERCLIP_API_KEY` must not be in the public process's
  environment (`FORBIDDEN_PUBLIC_ENV`, `server/src/v1/publicEnv.ts:49`) —
  construction throws. The list is capabilities, not settings: the breach
  watcher's credential is on it (ABL-591), its address and ids are not.
- CORS is an allowlist (`PUBLIC_CORS_ORIGINS`), default deny, credentials
  always false. Errors reach a caller only as `PublicApiError`
  (`server/src/v1/publicErrors.ts:27`); everything else collapses to a constant
  string, 5xx always a plain 500. Envelope: `{ error: { code, message } }`.
- Auth: `Authorization: Bearer able_<env>_<prefix>_<secret>`; keys + usage
  metering live in their **own SQLite database**, never the energy DB. A key
  without an account contact is refused (ABL-528).
- Metering undercounts on failure, never double-counts — an invoice slightly
  low is absorbed; slightly high is a refund and lost trust.
- Plan limits (`server/src/v1/quota/`) answer breaches with 429 only, per
  account not per key; numbers are source code in `planLimits.ts`, not config.
- A retrained artifact behind a served (zone, type, model) pair is a
  **material change**: it is not served until acknowledged
  (`server/src/v1/modelVersions/`), and the changelog is a table (not files)
  because ToS §9.3 makes publish latency contractual —
  `npm run changelog -- entries:publish …` from `server/`. The full §9.3
  serving sequence: `docs/claude/16-serving-a-changed-model-artifact….md`.
- **Breach detection reads `/v1`'s tables from the *private* process.** ABL-530
  records auth failures into the key-store file; the ABL-578 watcher
  (`startBreachWatchScheduler`, `server/src/services/breachWatchScheduler.ts:477`)
  runs in `index.ts` beside the ops schedulers, opens that file **readonly**
  (`openAuthFailureReader`, `server/src/services/breachWatch/authFailureReader.ts:92`),
  and on a trip opens a `priority: high` `INCIDENT:` issue for the CEO — the
  channel ABL-524 §6 fixed by Board decision. It lives there, not in the public
  process, so the Paperclip credential stays out of the process ABL-291 may
  expose — enforced by `FORBIDDEN_PUBLIC_ENV` above, not convention (ABL-591).
  That makes it a **third** documented reader of `api_keys.db`, which
  whoever builds Tier 2 (S1) must add to the baseline. Signals S4 and S2 fire on
  ABL-524 verdicts with no threshold; S3's cutoff
  (`PROVISIONAL_MIN_PREFIXES_PER_ORIGIN`,
  `server/src/services/breachWatch/signals.ts:155`) is **provisional** and says so
  in every incident it raises. S5 is deliberately not wired — it is ungraded by
  design.
- Launch is gated by ABL-349: no subscriber terms published, no external key
  issued until it closes.

## Data semantics — rules that bite

**Timestamps: two separators in one column.** Every timestamp column can hold
both `2026-07-20T00:00:00` and `2026-07-20 00:00:00` forms (writer- and
era-dependent), and SQLite compares them as strings, so **neither single form
is a correct window bound**. Use `server/src/utils/timestamp.ts`
(`timestampRange` + `rangeClause` + `rangeArgs`) for **every** window
predicate — including tables currently measured 100% one form. Never hand-roll
a normalizer (three private copies once drifted apart and made endpoints
disagree), and never put `REPLACE()`/`date()`/`strftime()` on the column alone
in a filter or join — it forfeits the index (a 51-second scar lives in
`docs/claude/25-common-issues.md`). Joins to actuals are separator-agnostic via
`resolvedActualJoin()` (`mlForecastService.ts:128`) and `metricSelect()`
(`crossCountryMetricsService.ts:121`). A series short by exactly one day at the
window's end is this bug.

**NULL, never 0, when a value is not measurable.** A confidently wrong number
is an incident; a missing one is a bug. Metrics are `null` when undefined
(e.g. WAPE over zero actual magnitude); `services/wape.ts` is the single WAPE
definition — never write a second one. Accuracy `null` fields mean "not
measurable in this window", not zero.

**Divergent-basis withholding (NL).** A country whose realized load and load
forecast are published on different bases (NL: forecast gross of
behind-the-meter solar, actuals net) gets every error measure **and** the
forecast line itself withheld — the difference is definitional, not forecast
error. The rule lives in `services/loadForecastBasis.ts` and every surface
must route through it (country tab, portfolio, `/api/forecasts` — which
reports `meta.withheldPoints`). Do not "fix" with a threshold; do not add
countries without probing raw ENTSO-E A65 documents first.

**Generation tables.** `energy_generation` (21 `*_mw` columns, full A75
document) is the table for anything new. `energy_renewable` is **frozen**;
`server/src` holds no read of it (verify with a bare-table-name grep). Both
are written from **one** A75 fetch — never add a second request to fill one.

**Freshness and staleness.** Stream verdicts are `live | stale | ended | none`
(`services/freshness.ts`); `stale` load/generation means >18h; `ended` means
>30 days and self-clears; both are derived, never hard-coded country lists. The
ingest cron runs at `30 0,6,13,18` UTC and refetches a rolling 7-day window, so
interior holes self-heal while inside it. Judge freshness by `MAX(timestamp_utc)`
**on prod**, never by `data_ingestion_log` (INSERT OR REPLACE rowcounts make a
healthy rewrite indistinguishable from a stall). Read-only remit: a frozen
`MAX(timestamp_utc)` has three inseparable causes (between passes / ingest
error / upstream stopped) — the honest verdict is "frozen, cause not yet
determined; upstream probe required". Grep `docs/claude/20-data-the-database-does-not-have.md`
for the frozen timestamp first — known upstream cutoffs are on file there.
**A read taken minutes after the cron minute is not a post-pass read** (ABL-554):
the pass walks 39 countries in one sequential alphabetical loop over 17-55 min,
so a country's refresh instant is its alphabetical position, not the cron minute
— AL finishes first, RS last. Before concluding a country was missed, check
`GET /api/data-freshness/:cc/ingest` → `lastChecked` per stream (built by
ABL-295): if it pre-dates the cron minute, the pass has not got there yet. A
falling `Retrieved N` across passes is a window artifact, not row loss — the
7-day window shrinks as old hours age out. Derive staleness from the pass
**end** time, never the cron start.

**The 21:00 UTC local-day boundary is an upstream signature** (ABL-551): CEST
zones (AL, MK, BA, ME, RS) that stop cleanly at `21:00:00` UTC with 22 rows on
the terminal date ran out their local day — upstream stopped; a real ingest
break cuts at an arbitrary mid-pass hour. GB (2021-06-14) and UA (2022-02-25)
are dead outright; small Balkan zones are chronically late and holey.

**`publication_timestamp_utc` records when we fetched, not when the value was
published** (ENTSO-E stamps documents at generation-on-request). Do not build
on it, and never backfill it — a backfill stamps rows with the backfill date.

More registry entries (offset-suffixed timestamps, LU/DE net-position zone
sharing, known gaps): `docs/claude/20-data-the-database-does-not-have.md`.

## Forecast models and serving

`server/src/config/forecastModels.ts` is the registry: which models may serve
which forecast type, and which is `production` per type. **A model must be
listed there to be served at all** — and a registry entry whose `model_name`
nothing writes is dead (registered = offerable, not served; check the
`forecasts` table for rows before adding).

- The client sends `model=` only on an explicit user pick; otherwise the
  server walks the candidate ladder (`resolveModelCandidates`,
  `forecastModels.ts:211-220`): production first, then other registered ml
  models, first with rows wins. catboost/xgboost country coverage barely
  overlaps, so pinning blanks countries; the picker labels whatever
  `meta.model` reports actually served.
- The displayed default is auto-selected per (country, type) by measured
  accuracy (ABL-469) but deliberately never pinned onto the wire.
- **Serving is data-driven end to end — no country allowlist exists.**
  Training a model is the whole job of adding a country to a stream
  (ABL-319): the first row written adds it everywhere. A country with no rows
  degrades to 200 + empty array; charts leave `forecast: null` rather than
  drawing zero (`buildSeriesGrid`, `client/src/lib/chartAdapters.ts:35`).
- Do not read a directory under `models/<CC>/<stream>/` in the sibling repo as
  a trained model — `Forecaster.load` opens top-level `model.joblib`
  (`../energy-forecast/src/forecaster.py:898`); without it the pair is skipped.

Feature-level history (tabs, time navigation, state management, comparison
metrics, freshness UI, visitor counters): `docs/claude/17-key-features.md`.

## Testing

```bash
cd client && npx vitest run && npx tsc -b
cd server && npx vitest run
```

- **Baselines rot; the delta is the durable half.** Re-measure after merging
  the base in, and again if the branch waits. A conflict-free merge is not a
  working merge — run the suite on the merged tree. Current tripwire absolutes
  and their history: `docs/claude/21-testing.md`. Client at `6b2fe01` +
  ABL-320: **55 files / 769 tests**, identical on Node 24 and Node 25.
- **A green client suite is a claim about your Node major unless the run says
  otherwise.** `dashboardStore` is a persisted zustand store; its middleware
  resolves the bare global `localStorage` once, at import, and calls
  `storage.setItem` on every `setState`. That global is broken in a *different*
  way on each Node: absent on 24 and earlier (zustand catches the
  ReferenceError and persist silently no-ops, so the suite is green but nothing
  about persistence is exercised), and present-without-`setItem` on 25, which
  threw `TypeError: storage.setItem is not a function` — 20 failures on the
  same commit that was green on 24 (ABL-320). **`@vitest-environment jsdom`
  does not fix this**: vitest aliases `window` to `globalThis`, Node's global
  wins over jsdom's, and all 20 failures survive `environment: 'jsdom'`
  (measured on 25.6.1 + jsdom 30). What fixes it is
  `client/vite.config.ts:88`, whose `setupFiles` installs a real Storage
  (`installMemoryStorage`, `client/src/test/memoryStorage.ts:105`) before any
  test module is imported. Do not replace it with an environment switch, and
  do not add a per-file `localStorage` shim — one existed in
  `LoadTab.test.tsx` and hid the problem for every other file. On Node 25 the
  run also prints a `--localstorage-file was provided without a valid path`
  warning per worker; that is Node's, not ours, and is not a failure.
- **The client suite is Node-agnostic; the server suite is not — use Node 24
  for both.** `server/node_modules/better-sqlite3` is compiled for Node 24
  (ABI 137), so `cd server && npx vitest run` under Node 25 halts on the
  ABL-309 preflight (`server/src/test/nativeAbiPreflight.ts`) rather than
  running. That one names its own cause, so it needs no triage — but do not
  read "the client passes on 25" as clearance to run the whole repo on 25.
  Both Nodes are installed here: `C:\Program Files\nodejs` is v25.6.1 and the
  nvm4w default on `PATH` is v24.18.0.
- **Server test files are excluded from the default typecheck** — `server/tsconfig.json` excludes
  `src/**/*.test.ts`, so a required-argument omission compiles clean (ABL-533). Run
  `npm run typecheck:test` (from `server/`) to typecheck them explicitly; it is **green as of
  ABL-587**, so a red run is a real regression, not pre-existing noise.
- **Before you mark an issue `done`:** `npm run predone` (from the repo root).
  Three gates: per-branch shipping gap (patch identity via `git cherry`, not
  ancestry), unpublished local `main`, and stranded work on any local branch.
  **Publishing to `origin/main` is the last step of `done`** — prod builds
  from the remote; unpushed work has not shipped, whatever the board says.
- **This file's `file:line` citations are checked** by
  `server/src/docs/claudeMdCitations.test.ts`: the cited line must exist,
  hold content, and contain/enclose the named top-level symbol. Bare `:NNN`
  continuations cite use-sites and are allowed. Deliberate comment citations
  go in `COMMENT_CITATION_ALLOWLIST`. Citations into
  `../energy-data-gathering` are presence-only. Set
  `CLAUDE_MD_CITATIONS_REF=HEAD` (or any ref) to check a committed snapshot.
  **Never write a port as a backticked bare colon-number** — write "port 5173";
  the checker reads the backticked form as an orphan citation and the suite
  goes red.

## Common Development Tasks

**Adding a new API endpoint:** route in `server/src/routes/`, service in
`server/src/services/`, types in both `server/src/types/index.ts` and
`client/src/types/index.ts`, API fn in `client/src/services/api.ts`, React
Query hook in `client/src/hooks/useDashboardData.ts` (or a per-tab hook).

**Adding a chart feature:** store state in `dashboardStore.ts` (if persisted:
add to `partialize`, bump `PERSIST_VERSION`, add a `migratePersisted()` clause
in `store/migrate.ts`), extend the relevant hook, update the tab component and
the `Able*` primitive, add UI toggles in the tab / `ModelPicker` / `TimePicker`.

**Adding a model to the registry:** `FORECAST_MODELS[type].models` (and
`production` if default) in `server/src/config/forecastModels.ts` — picker,
ladder and accuracy validation all read the registry; nothing else changes.
Check rows exist for the `model_name` first (see Forecast models above).

**Modifying TSO or ML forecast display:** `forecastModels.ts` (what exists),
`tsoForecastService.ts` / `mlForecastService.ts` / `forecastService.ts`
(queries), `ModelPicker.tsx` (selection), `LoadTab.tsx` / `PriceTab.tsx` /
`NetPositionTab.tsx` (render).

## TypeScript Types

```typescript
type TimeAnchor = 'past' | 'now' | 'future';
type TimePreset = '24h' | '7d' | '30d' | 'today' | 'thisWeek'
                | 'next1d' | 'next24h' | 'next48h' | 'next7d';

// Per stream (ABL-60). `ageHours` is signed and server-computed; negative is
// normal for a day-ahead stream.
type FreshnessStatus = 'live' | 'stale' | 'ended' | 'none';
interface FreshnessStream { latest: string | null; ageHours: number | null; status: FreshnessStatus; }
interface DataFreshness {
  load: FreshnessStream; price: FreshnessStream; generation: FreshnessStream;
  tsoLoadForecast: FreshnessStream; tsoGenerationForecast: FreshnessStream;
}

type ForecastSource = 'ml' | 'tso';
interface ForecastModel {
  id: string;                 // wire id, e.g. 'catboost', 'tso-d7'
  label: string;              // 'able-ml · catboost'
  source: ForecastSource;
  modelName?: string;         // forecasts.model_name, for ml models
  tsoHorizon?: 'day_ahead' | 'week_ahead';
}
interface ForecastTypeConfig { production: string; models: ForecastModel[]; }
type ForecastModelRegistry = Record<string, ForecastTypeConfig>;
```

**TSO forecast types: client and server declarations are NOT mirror images.**
The client's `TSOLoadForecastDataPoint` (`client/src/types/index.ts:281`) adds
`forecast_min_mw`/`forecast_max_mw` (week-ahead only, `tsoForecastService.ts:71-72`,
NULL on day-ahead) that the server's (`server/src/types/index.ts:170`) lacks;
`TSOGenerationForecastDataPoint` is server-only (`server/src/types/index.ts:245`,
duplicated at `tsoForecastService.ts:27`). Check which side you are on.

## Debugging Tips

- No React Query DevTools here — inspect via the Network tab or a temporary log.
- The server logs the connected `ENERGY_DB_PATH` at startup
  (`config/database.ts:15`) and again if the write handle opens
  (`config/writeDatabase.ts:29`). It does not log queries.
- Acceptance proxies the built CAT Docker image, not the working tree — use
  the `PORT=3002` + local `ENERGY_DB_PATH` procedure in
  [`../WORKFLOWS.md`](../WORKFLOWS.md), **API proxy on CAT**.
- Prod-vs-replica: see Database Connection above.

## Common Issues

Condensed diagnostics — full entries with the reasoning in
`docs/claude/25-common-issues.md`.

- **"Cannot connect to database":** `ENERGY_DB_PATH` unset or pointing at a
  missing file.
- **`database is locked` on the workstation replica:** `able-db-sync` is mid-run
  (Scheduled Task at 07:00 / 16:30 local, 30–60 min variable window — see
  Database Connection). Check the `.db-journal` mtime and
  `C:\Code\able\logs\sync-db-v2.log`; wait for the lock to clear. Not a bug
  (ABL-612).
- **Forecast-accuracy tab shows a sentence instead of numbers / Load tab draws
  no forecast line (NL):** the divergent-basis rule working — see Data
  semantics. Not missing data; do not "fix" it.
- **A load/price forecast is blank:** read the card first (withheld?); then
  check which models are checked in `ModelPicker` — coverage barely overlaps,
  and a checked-but-empty model stays in the legend hatched with a
  "Remove from comparison" footnote; "Default — automatic" clears every pin.
  Confirm the model is registered.
- **TSO forecasts not showing:** `load` has D+1 and D+7; `solar`/`wind_*` D+1
  only; `price`/`net_position` and others none — check `forecastModels.ts`
  before assuming a bug. `ModelPicker` does not render on Generation,
  Forecast-accuracy or Net position tabs (`TABS_WITH_MODEL_PICKER`,
  `CountryDashboardView.tsx:69`, applied at `:129`); Net position has its own
  multi-select picker.
- **D+7 band not showing:** the band draws only when D+7 is the *sole* checked
  model; needs daily `forecast_min_mw`/`forecast_max_mw` rows.
- **Header pill "stale"/"tomorrow missing":** the signal working — read
  `/api/data-freshness/:cc`, then settle on prod (see Data semantics).
- **Time navigation:** ranges come from `getDateRangeForPreset()`
  (`useDashboardData.ts:47`); a "stale" chart is often a shifted window
  (`timeOffset` is in ~10 query keys). Changed persisted shape → bump
  `PERSIST_VERSION` + migration clause.
- **Slow query filtering/joining on `date()`/`strftime()`:** function-of-column
  defeats the index — see Data semantics (timestamps).
- **API returns HTML or `unwrap()` reports a malformed envelope:** the server
  decides "production" from the existence of `client/dist/index.html`, a branch
  a dev checkout never takes; handlers are registered unconditionally and the
  SPA fallback skips `/api` (pinned in `server/src/app.test.ts:118`).
- **Every `/api` route returns an HTML 404 on localhost port 3001:** read the
  response headers — a `Server:` header we never set means an unrelated
  listener owns loopback on that port (CAT). Environment problem; use the
  WORKFLOWS.md port-owner checks, do not change the Vite proxy default.

## Archive

`docs/claude/` holds the full pre-2026-08-27 narrative this file was distilled
from (ABL-536), one file per former section — incident forensics, dated
measurements, design rationale. Citations there are frozen. Start with the
matching topic file whenever a rule here needs its evidence or history.
