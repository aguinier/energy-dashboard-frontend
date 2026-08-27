> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# `/v1` plan limits refuse requests and never suspend anything

## `/v1` plan limits refuse requests and never suspend anything

ABL-302. `server/src/v1/quota/` enforces a per-minute rate limit and a monthly
quota, both by plan tier, and answers a breach with a 429 and nothing else.
`createPlanGate` (`server/src/v1/quota/planGate.ts:264`) is mounted between the
usage meter and the resources — *after* the meter so a refusal is still recorded
as traffic, *before* the routes so a refused request does not first run a
366-day query.

**The numbers are the ABL-291 brief §1.2 table**, in `planLimits.ts` as source
rather than as configuration: Explorer 1,000/month at 10/min, Developer
50,000 at 60/min, Professional 500,000 at 300/min, Enterprise negotiated (no
monthly quota, 600/min as a service-protection default). Explorer and Developer
hard-stop; Professional soft-overages at €1.00/1,000 up to a bill cap of 2× the
plan price, which derives a ceiling of 749,000. Retention periods are read from
the environment because ABL-297 §5 requires it; a quota is the opposite kind of
number, and an operator who could raise one with an env var could give the
product away without a diff.

**Both limits are per account, not per key.** `MAX_LIVE_KEYS_PER_ACCOUNT` is 5,
so a per-key quota would deliver five times what a customer bought. The per-key
split is not lost — `usage_rollup` is keyed `(account, key, month)` and the
invoice reads from there.

**The quota counter is seeded, not queried.** A `SELECT COUNT(*)` per request
would put a disk read on the critical path and would still be stale, because the
meter buffers. Instead each `(account, month)` is seeded once from
`servedRequestsInMonth`, counted in process, and reconciled every 60 seconds by
taking `max(counted, durable)` — both are lower bounds on the same total, so the
larger is the better one and it can neither lose our own unflushed requests nor
double-count them. A failed read serves rather than refuses. That figure reads
`usage_events` and **not** the rollup, which is the opposite of the rule an
invoice follows: an invoice must come from the aggregate that survives
retention, a quota is enforced against a month still open.

**A 429 excludes itself from the quota.** Every request is metered including
refusals, and `servedRequestsInMonth` excludes `THROTTLED_STATUS`, so the
durable seed and the in-process counter mean the same thing. A 4xx *does* consume
quota — a broken client's errors are not free traffic — and is still not billable.

Headers on every authenticated response: `RateLimit-Limit`, `-Remaining`,
`-Reset` (the IETF draft names), `Quota-Limit-Month`, `Quota-Remaining-Month`,
`Quota-Overage-Month` for a plan that can accrue one, and `Retry-After` on a
429 — seconds for a rate breach, seconds until the UTC month rolls over for a
quota breach. All seven are in `publicApp.ts`'s CORS `exposedHeaders`, and
`publicApp.test.ts` checks the two lists agree: a header a browser cannot read
is a quota a browser client cannot respect. Three refusal codes, because the
fixes differ: `rate_limit_exceeded`, `quota_exceeded`, `overage_cap_exceeded`.

**Enforcement stops at the 429, and that is a written commitment.** ABL-297
filed it on this issue from a Board decision: automated throttling and automated
429s are permitted (privacy notice §8 — a technical control, not a decision
about a person, which is what keeps it outside GDPR Art. 22), but suspending or
terminating an account is never fully automated (AUP §6.5 — a human reviews and
confirms, and the subscriber can appeal). So nothing here disables a key, flags
an account or accumulates state across breaches: the request after a 429 is
evaluated exactly like the first. The gate is handed a `MonthlyUsageReader` —
one method, reads one integer — and `planGate.test.ts` walks its import graph to
assert it cannot reach `sqliteApiKeyStore.ts` or the keys CLI, where
`setAccountDisabled` and `revokeKey` live. An enforcement path beyond a 429 must
stop at a queue or a flag for a human, and would fail that test until somebody
named it, which is the point at which the commitment gets read again.

**The per-request row cap is ABL-303's, not this issue's** — `MAX_ROW_LIMIT` is
10,000 in `data/params.ts`, one figure for every plan, with `MAX_WINDOW_DAYS`
366 bounding what has to be looked at. No tier raises it: `planLimits.ts` does
not import `params.ts` and `planLimits.test.ts` asserts that its whole import
graph is one module. A plan buys more requests, never bigger ones — which is
what makes requests-per-month a billing dimension that prices anything (brief
§1.3).
