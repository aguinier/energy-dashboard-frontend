> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# `/v1` usage metering is the number a customer gets billed on

## `/v1` usage metering is the number a customer gets billed on

`server/src/v1/usage/` counts every authenticated request per key, survives a
restart, and aggregates to a monthly figure an invoice is raised from (ABL-301).
The tables live in the **same SQLite file as the key store** — never the energy
database — and `sqliteUsageStore.ts` reuses `resolveApiKeysDbPath` so there is
one decision about that path and one guard to keep true.

**Where the error is allowed to go.** Every place a failure forces a choice
between counting a request twice and not counting it at all, this code chooses
not to count it, and says so at the line where the choice is made. An invoice
that is slightly low is a margin absorbed quietly; an invoice that is slightly
high is a refund, an apology, and a customer who checks every future invoice by
hand. The two failure modes are named and tested rather than hoped about:

- **Lost write.** The meter buffers and flushes on a timer
  (`usageMeter.ts`), so a hard kill discards at most one second of that
  process's traffic. The alternative — an fsync on the critical path of every
  authenticated request, in a single-threaded process — was rejected
  deliberately. A shutdown that *runs its handler* loses nothing:
  `usageShutdown.ts` flushes, aggregates and closes, in that order, and is
  tested. Note the caveat, established against a running server rather than
  assumed: **Windows does not deliver `SIGTERM`**, so a `taskkill` there skips
  the handler entirely and loses whatever was buffered. `SIGINT` (Ctrl-C) is
  emulated and does arrive; on Linux both do.
- **Double count.** `usage_events.request_id` is unique and the insert is
  `ON CONFLICT(request_id) DO NOTHING`, so a flush that commits and is then
  retried inserts nothing. `INSERT OR IGNORE` was wrong here and was changed: it
  suppresses `NOT NULL` and `CHECK` violations too, which turned a discarded
  billing record into a number that read like a benign retry.

**`usage_events.id` is `INTEGER PRIMARY KEY AUTOINCREMENT`, and the keyword is
load-bearing.** The rollup is watermarked on the highest id it has aggregated. A
bare rowid is reassigned as `max(rowid)+1`, so once retention deletes rows the
next request would reuse an id below the watermark and be skipped by the rollup
forever — billing the customer zero, which is the one error nobody reports.

**The monthly aggregate is materialised, not derived** (`usage_rollup`,
ABL-297 §9(2)). An invoice is read from that table and never from a scan of raw
events, because the raw rows are deleted at 13 months and an invoice must be
defensible for about seven years. A month is closed explicitly, closing is
idempotent, and a closed month is final — a late event increments `late_*`
columns and never changes a figure that has already been sent out.

**Retention is a running job, not a policy** (`usageMaintenance.ts`): source IP
and user agent cleared at 90 days, de-identified records deleted at 13 months,
both periods read from configuration. It never deletes an event the rollup has
not aggregated, and it is scoped to `usage_events` alone — this is the first
scheduled deletion in the codebase, so it is where a general-purpose row reaper
would grow, and forecast vintages are contractually not prunable (ToS §9.3).

`npm run usage -- usage:month --month YYYY-MM` is the invoice figure;
`usage:stats` reports whether the published retention is actually being met;
`usage:export` answers a subject access request. The procedure for that, and the
full account of what is recorded and why, is in
`server/src/v1/usage/PRIVACY-AND-RETENTION.md`.
