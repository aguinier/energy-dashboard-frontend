> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# The public `/v1` app is a second app, not a filtered first one

## The public `/v1` app is a second app, not a filtered first one

`server/src/v1/` holds a **separate Express application** for the commercial
`/v1` surface, built by `createPublicApp`
(`server/src/v1/publicApp.ts:204`) and run as its own process from
`server/src/v1/publicIndex.ts`. It is not `createApp()` with routes hidden.

The distinction is the whole point (ABL-304, specified by ABL-293 §2f). A
middleware allowlist is a list somebody has to remember to update; when they do
not, the failure is silent and the failure mode is "an ops endpoint became
public", noticed in a log if at all. The public app instead **does not import**
`routes/index.js`, so `/api/ops/status`, `/api/health`,
`POST /api/forecasts/net-position`, `/api/weather/*` and `/api/dashboard/*` are
not routes on it in any middleware order — the handlers are not in its
dependency graph.

Four absences, each load-bearing:

- **No `routes/index.js`** — and therefore none of the 52 internal handlers.
- **No static mount and no SPA fallback.** `publicNotFoundHandler`
  (`server/src/v1/publicErrors.ts:98`) is the only catch-all, so the entire
  "unmatched path answers 200 index.html" class of bug (ABL-13) is absent by
  construction rather than fixed.
- **No body parser.** There is no `POST` on this surface, so no
  `express.json()` — which also leaves the 4 MB ingest exception (`app.ts:83`)
  nothing to attach to.
- **No `config/writeDatabase.js`.** `getWriteDb()` is unreachable, so an ingest
  write from this process is impossible by absent capability, not by a check
  that returned false.

Three things differ from the private app on purpose, and all three are the
"cheap now, expensive to retrofit" decisions ABL-291 brief §2 names:

- **CORS is an allowlist**, `PUBLIC_CORS_ORIGINS` parsed by
  `parsePublicCorsOrigins` (`server/src/v1/publicEnv.ts:90`), defaulting to
  *deny*. `app.ts:72-75`'s `origin: true` with `credentials: true` reflects
  whatever `Origin` a caller sends and then permits credentialed requests
  against it; `/v1` authenticates with `Authorization: Bearer`, never a cookie,
  so `credentials` is always false here.
- **Errors are scrubbed by inversion.** A message reaches a public caller only
  when it was built as a `PublicApiError` (`server/src/v1/publicErrors.ts:27`)
  — i.e. written for a customer. Everything else, whatever its type, gets a
  constant string chosen by status, so there is no branch that can echo a file
  path, a SQLite column name, a hostname or a commit SHA. A 4xx keeps its
  status (a claim about the request); a 5xx always collapses to a plain 500.
  The envelope is `{ error: { code, message } }`, not the internal
  `{ success, error, code }`.
- **`helmet`'s `upgrade-insecure-requests` stays.** `app.ts:64-72` nulls it out
  so the dashboard can be served over plain HTTP on the LAN. That exception is
  precisely what must not travel into the public profile, and keeping it costs
  nothing today: the directive governs subresource loading, and a JSON response
  has no subresources.

**`HELIO_WRITE_TOKEN` must not be in this process's environment**, nor
`JAO_CORE_NET_POSITION_ENABLED`, `OPS_PEER_URL` or `COMMIT_SHA`
(`FORBIDDEN_PUBLIC_ENV`, `server/src/v1/publicEnv.ts:30`). `createPublicApp`
throws at construction if one is set, naming the variables and never their
values. Nothing in the public graph *reads* them — that is what the import-graph
test proves — and this is the second lock, because "unused" is a property of
today's code while "absent" is a property of the deployment.

### How the isolation is checked

Two independent tests, and neither is sufficient alone:

- `server/src/v1/publicApp.test.ts` — behavioural. Boots the real public app
  and asserts every internal path 404s with the public envelope. This would
  *also* pass on an app that mounted the internal router behind a filter, right
  up until someone reordered the filter.
- `server/src/v1/publicAppGraph.test.ts` — structural. Walks the import graph
  with `walkModuleGraph` (`server/src/v1/importGraph.ts:144`) and asserts no
  ops, write, ingest, dashboard, health-provenance or release module is
  reachable from either `publicApp.ts` or `publicIndex.ts`, and pins the exact
  module set. This file **reads the app as text and never imports it** — twice
  deliberate: importing would execute the code under test and open the shared
  database as a side effect, and when the isolation really is violated the app
  module often stops being importable at all, which would take a test file that
  imported it down with a load error and report "no tests" instead of naming
  the module that arrived.

A route added to `/v1` goes in `server/src/v1/routes/index.ts`; if it reaches
back into `routes/`, a shared ops service or a write handle, the graph test
fails and says which module and by which path. The exact-module-set assertion
is meant to be updated deliberately — an edge added there is the moment the
isolation stops being free.

Not done by ABL-304, and deliberately: the `/v1` resources themselves
(ABL-303), metering (ABL-301), quotas and the row cap (ABL-302), and the
OpenAPI document and its drift check (ABL-305, since landed — see below).
API-key auth is ABL-300, below.
The public process binds `127.0.0.1` by default and **is not deployed or
exposed**; `PUBLIC_BIND_HOST` exists so the bind address is configuration
rather than a code change, but choosing anything other than loopback is a
network-exposure decision that needs its own Board-approved issue.

## Breach-watch signal grading (ABL-578, moved from `CLAUDE.md` 2026-09-10)

ABL-530 records `/v1` auth failures into the key-store file; the ABL-578
watcher (`startBreachWatchScheduler`,
`server/src/services/breachWatchScheduler.ts`) reads them from the **private**
process and, on a trip, opens a `priority: high` `INCIDENT:` issue for the CEO
— the channel ABL-524 §6 fixed by Board decision. The durable half of that
(where it runs, why it runs there, and that it is a third reader of
`api_keys.db`) is in the repo-root `CLAUDE.md`. What follows is the grading.

- **S2 and S4 fire on ABL-524 verdicts with no threshold of their own.** They
  inherit a decision that was already made and graded elsewhere, so there is no
  number here to tune or to distrust.
- **S3's cutoff is provisional and says so out loud.**
  `PROVISIONAL_MIN_PREFIXES_PER_ORIGIN`
  (`server/src/services/breachWatch/signals.ts`) was chosen without a
  distribution to fit it to, because `/v1` has no external traffic yet
  (ABL-349). Every incident S3 raises carries that caveat in its own text, so a
  reader never has to come here to learn that the number is a guess. Re-fit it
  against real traffic before treating it as a measured threshold.
- **S5 is deliberately not wired.** It is ungraded by design, not an oversight
  and not a TODO. Wiring it needs a grading decision first.

**For whoever builds Tier 2 (S1):** the watcher is the **third** documented
reader of `api_keys.db`, after the public app and the key-issuance tooling. A
Tier 2 baseline that counts readers must include it, or the watcher's own
readonly opens will read as the anomaly it is looking for.
