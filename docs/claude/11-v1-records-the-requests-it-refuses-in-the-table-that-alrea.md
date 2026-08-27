> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# `/v1` records the requests it **refuses**, in the table that already has a retention job

## `/v1` records the requests it **refuses**, in the table that already has a retention job

ABL-530, ABL-349 gate item 2 Tier 1, implementing the `breach-signals` document
on ABL-524. `server/src/v1/security/` records every refused authentication, and
adds four investigation commands to `npm run usage`. **Recording and reading
only — nothing here alerts anybody**; where an alert should go is an open Board
decision (ABL-524 §6).

**The gap it closes.** A failed authentication produced no durable record
anywhere. `publicApp.ts` mounts the gate, then the meter, then the plan gate,
and every refusal in `apiKeyAuth.ts` ends with `next(authError(...))` — which
jumps to the error handler and never reaches the meter. `usage_events` could not
have held the row in any case: `account_id` and `key_id` are both `NOT NULL` and
a failed auth has neither. **This is not a defect in the metering work**; the
meter is a billing meter and it is mounted exactly where a billing meter
belongs. The only trace was `publicErrors.ts:112`'s `console.error`, over a body
whose every message is a constant — so it said a 401 happened and nothing about
who, from where, or against which prefix, and only if stdout were being captured
somewhere, which it is not.

**The prefix is the whole point of the record.** `ApiPrincipal.keyPrefix`
(`server/src/v1/auth/apiKeyAuth.ts:68`) is documented as "the non-secret handle
— safe to log, and the thing support will ask for", and
it is the one column that separates *many prefixes from one address*
(enumeration) from *one prefix from one address* (a customer with a stale key).
Same status code, opposite meanings, and indistinguishable before this. The
presented **secret** is never recorded — not hashed, not truncated, not
prefixed-plus-N; there is no column that could hold one, and the test drives
real keys through the real gate and asserts they are absent from the *bytes on
disk*. A store of attempted secrets would be a second credential store, filled
from the open internet, with none of the protections the real one has.

Six properties, in rough order of how expensive each would be to rediscover:

- **The response did not change, and that is the constraint the design is built
  around.** `apiKeyAuth.ts` returns `key_invalid` for every pre-secret failure
  and burns a `timingSafeEqual` on an unknown prefix so that "no such key" costs
  what "wrong secret" costs — otherwise the *non-secret* prefix is an
  enumeration oracle answerable by stopwatch. Recording must not hand that back,
  so `recorder.record()` **does no I/O and cannot throw**: it stamps a few
  fields and pushes onto an array, and the sink is touched by a timer and by
  `setImmediate`, never by the request. Both branches gather the same fields,
  including the prefix on the unknown-prefix path, because a field gathered on
  one branch and not the other is work done on one branch and not the other.
- **The early flush is `setImmediate` here where the meter's is inline, and the
  difference is not stylistic.** The meter counts *authenticated* traffic, which
  the plan gate has already bounded by a rate limit and a quota. This path is
  mounted **ahead** of both, so a refused request is the one kind of traffic on
  this surface that nothing throttles; an inline flush would let an attacker turn
  each guess into a synchronous SQLite write in a single-threaded process — a
  monitoring feature that is also a denial-of-service amplifier.
- **`secret_verified` is written where it is known, not derived from
  `error_code`.** Revoked, expired and disabled are reachable **only after**
  `secretMatchesHash` succeeds, so anyone who triggers one holds a real key —
  there is no guessing path to them (ABL-524 §2, S4). Deriving it from the code
  would be wrong *today*, not merely fragile: `key_invalid` is produced on
  **both** sides of that comparison, because an environment mismatch reaches it
  having already proven the secret.
- **The route template comes from a closed table** (`requestTarget.ts`), never
  `req.path`. On a refused request the path is an unauthenticated,
  caller-controlled string and this table is fed by the callers we trust least —
  the free-text-shaped value ABL-297 §9(5) forbids, kept for thirteen months.
  Anything unmatched is `(unrecognised)`, which is a finding in itself. The
  meter's `resolveRouteTemplate` could not be reused: it reads `req.route`,
  which Express never sets on a request the gate refused, so every row would
  carry the constant `(unmatched)`.
- **Retention shipped with the write path, and that ordering was the
  requirement.** `auth_failures` holds `client_ip` and `user_agent`, so it is
  inside the ABL-297 §5 promise from its first row. It is scrubbed and deleted by
  `applyRetention` **in the same transaction** on the same two boundaries, and
  `usage:stats`'s `unscrubbedPastPii` is now the sum across both tables with a
  per-table breakdown. A compliance figure that kept covering one while a second
  filled with addresses would still print `COMPLIANT` — a detection feature that
  quietly becomes a privacy-notice violation is a worse outcome than not building
  it. The subject access export covers it too, for the same reason one procedure
  over.
- **Its delete is unconditional where `usage_events`' waits for the rollup
  watermark**, and the asymmetry is deliberate. That gate exists because an
  un-aggregated event deleted at 13 months is a request permanently missing from
  an invoice; nothing aggregates or invoices from this table, so a gate here
  would be a condition that is always true — which reads to the next maintainer
  as protection that is not there.

**Where the code lives, and what is *not* in the serving graph.**
`authFailureStore.ts` is the shape and the two capabilities (pure);
`authFailureRecorder.ts` the buffer; `sqliteAuthFailureStore.ts` the SQL, handed
an **already-open handle** rather than opening one, so
it is absent from the list of database-opening modules `publicAppGraph.test.ts`
names one by one. **Read that assertion's membership, never its count** — the
count moved while this issue sat in review, when ABL-532's change-log store
opened one; a count would also pass if somebody deleted a module and added
another, which is why the test names them. `createPublicApp`'s module list is
**unchanged by this
issue** — the gate takes an `AuthFailureRecorder` as a type and `publicIndex.ts`
constructs one, exactly as ABL-301's metering and ABL-302's quota are absent
from it. The three new entrypoint modules are named in that test.

**The four reads** (`npm run usage -- security:help`), one per ABL-524 §2 signal:

| command | signal | the finding |
|---|---|---|
| `security:auth-failures` | S3 | refusals by origin and by prefix. Many prefixes from one address is enumeration; one prefix from many addresses is a leaked key |
| `security:secret-holders` | S4 | refusals *after* the secret matched, cross-referenced against the addresses that key was actually served from |
| `security:key-origins` | S2 | a new origin appearing **while an older one keeps running** — theft, as opposed to a redeploy |
| `security:key-breadth` | S5 | distinct `request_fingerprint`s per key against **its own** baseline, never a global one |

All four take `--limit` and print 25 rows per table by default, then say how
many they did not show. That cap was found by running the command rather than by
reasoning about it: the very shape S3 exists to surface — one address presenting
hundreds of prefixes — produces one row *per guessed prefix*, so a 900-prefix
enumeration pushes the finding nine hundred lines off the top of a terminal. The
flood is the signal, and printing all of it is what hides it. A silent
truncation on a security report would be the worse defect, so the dropped count
and the total are on their own line.

`securityReport.ts` holds the judgement, pure and colocated-tested, and **every
verdict in it is a fact about timestamps or counts — none is a threshold.** That
is this repository's own scar: `METRIC_THRESHOLDS` graded forecast error against
uncalibrated cutoffs and stamped 24 countries "Needs Improvement" from 9.9% to
76.8%. The temptation is worse here, because `/v1` has **no live traffic at
all**, so any multiple picked today would be invented against zero observations
and then read at 03:00 as though it meant something. So S5 reports its ratio and
**declines to grade it**, and S3 prints two orderings with the ABL-524 reading
guide and no verdict; S2 and S4 can speak plainly because their findings are
comparisons, not quantities.

**Three verdicts exist only to stop a confident false claim**, and all three
come from the 90-day boundary being a published commitment rather than a
tunable:

- `no_history` (S2) — the key's whole retained address history begins with the
  origin in question, so "never used from here before" is unfalsifiable. A
  recently issued key and one whose earlier history was scrubbed look identical.
- `origin_unknown` (S4) — the refusal's own address has been scrubbed, so the
  question cannot be asked. **The trap this exists for is SQL's, not a
  reader's**: `u.client_ip = f.client_ip` with a `NULL` on either side is not
  true, so a plain `COUNT(*)` returns `0` — byte-identical to "never served from
  here", which is the most alarming verdict on the page, manufactured out of a
  row we deleted ourselves. The store returns `null` instead.
- `onboarding` (S5) — no baseline of this key's own, so there is no ratio. A new
  subscriber's first week looks like extraction against a global baseline and
  like onboarding against their own.

**Why now, with nothing to detect.** `/v1` is not exposed (`PUBLIC_BIND_HOST`
defaults to `127.0.0.1`) and no external key exists, so this catches nothing on
the day it lands. It is worth everything 90 days later: the window only holds
what was recorded while it was running, and ABL-349 item 2 closes by the
detection existing **before** the first external key, not by having watched and
seen nothing.

Not done here, and deliberately: S1 (who read `api_keys.db` — host and OS work,
Operations Engineer, and the only signal on the list that *is* a personal data
breach rather than evidence of one), S6 (conditions to attach to the ABL-291
exposure decision), S7 (item 1's inbox, unowned), and any alerting at all.
