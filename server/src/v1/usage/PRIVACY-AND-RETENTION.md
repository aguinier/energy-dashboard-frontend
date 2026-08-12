# Usage metering: what we record, how long we keep it, and how to answer for it

Companion to the code in this directory. It exists because three of the
requirements on ABL-301 are **procedures a person carries out**, not behaviours a
program exhibits — and a procedure that lives only in someone's head is the same
as not having one.

Source of truth for every number here is the `privacy-notice` and `tos`
documents on ABL-297. Where this file and those disagree, those win and this file
is wrong. Do not change a period here without changing it there.

---

## 1. What is recorded, per request

One row in `usage_events` per authenticated request. The full column list is in
`sqliteUsageStore.ts`; what matters for a privacy notice is which of them are
about a person.

| Recorded | Personal data? | Why we hold it |
|---|---|---|
| account id, key id | Pseudonymous | Attribution — this is what an invoice is keyed to |
| received at, duration, status | No | Billing and capacity planning |
| route **template** | No | Which resource was served |
| query parameters | No, **by construction** | See §2 |
| rows returned, response bytes | No | Capacity planning, and the ABL-293 §2d pricing dimension |
| `Idempotency-Key` | Caller-chosen | Recognising a retry, so we do not double-bill |
| **source IP** | **Yes** | Rate limiting, key-sharing detection, security investigation |
| **user agent** | **Yes** | Abuse detection |

The last two are the reason a privacy notice is needed at all. An IP address is
personal data under the GDPR. They are also the only two fields the retention job
in §3 clears.

### What is deliberately not recorded

- **The raw URL.** Only the route template (`/v1/observations/:series`), never
  the path a caller actually sent. A raw URL carries a customer's query patterns,
  explodes the cardinality of every aggregate over the column, and is the obvious
  accidental route for a customer identifier to reach the log.
- **Request or response bodies.** There are none on this surface.
- **The `Authorization` header, or any part of a key beyond the non-secret
  prefix.**
- **`X-Forwarded-For`.** The IP is read off the socket. There is no proxy in
  front of this deployment and `trust proxy` is not set, so an `X-Forwarded-For`
  arriving today is a value the *caller* chose — recording it would corrupt the
  one field we rate-limit on and name in the notice as personal data.

---

## 2. Query parameters cannot become a personal-data vector

**ABL-297 §9(4).** Query parameters are logged, and today they are market-data
values — country, date range, horizon. The control is an **allowlist** in
`usageStore.ts` (`LOGGED_QUERY_PARAMETERS`), not a denylist.

That choice is the whole of the protection, and it is worth being explicit about
why. A denylist depends on somebody remembering to add an entry at the moment
they add a parameter — which is the moment they are thinking about the feature,
not about the log. With an allowlist, a new parameter is excluded because nobody
listed it. The default is the safe one and the mistake is unrepresentable rather
than unlikely.

**If you are adding an endpoint that accepts free text, a customer-supplied
identifier, or anything a caller writes rather than chooses:** do nothing. It is
already excluded. Adding its name to `LOGGED_QUERY_PARAMETERS` is the action that
would create the problem, and `usageStore.test.ts` fails if a name from the
obvious list (`q`, `search`, `email`, `name`, `ref`, `user`, `id`, `filter`) ever
appears there.

A 64-character cap on each recorded value backs the allowlist up, so a parameter
that later starts accepting something larger cannot quietly turn the log into a
store of whatever the caller sent.

---

## 3. Retention is a job, and it runs

**ABL-297 §5.** Two periods, both read from configuration
(`USAGE_PII_RETENTION_DAYS`, `USAGE_EVENT_RETENTION_MONTHS` — see
`server/.env.public.example`):

| At | What happens | To |
|---|---|---|
| **90 days** | `client_ip` and `user_agent` are set to NULL, `pii_scrubbed_at` is stamped | `usage_events` |
| **13 months** | The de-identified row is deleted outright | `usage_events` |
| **never** | — | `usage_rollup` |

It runs two ways, and both are the same code path (`runUsageMaintenance`):

- **Automatically.** The public process runs a full pass every six hours
  (`startUsageMaintenance`, wired in `publicIndex.ts`). Nothing external needs to
  be scheduled for the published periods to be met.
- **By hand.** `npm run usage -- usage:retention`, or `usage:maintain` for the
  whole pass.

Three properties worth knowing before you touch it:

1. **It never deletes an event the rollup has not aggregated.** Deleting one
   would remove it from an invoice permanently. Retention keeps the row instead
   and reports the count as `keptPendingRollup`. A non-zero number there is a
   *rollup* alert, not a retention one: fix the rollup, then re-run.
2. **It is scoped to `usage_events` and nothing else.** ABL-301 is the first
   scheduled deletion in this codebase, which makes it the place a future
   general-purpose row reaper is most likely to grow. **Do not build one.** ToS
   §9.3 commits us to retaining forecast vintages so a subscriber can reconstruct
   what a model said at the time; forecast vintages must never be pruned for
   storage reasons.
3. **`usage_rollup` is out of scope on purpose.** Accounting law requires the
   figures an invoice was based on for roughly seven years, and the raw rows are
   gone at thirteen months. See §4.

### Checking it is actually happening

```
cd server
npm run usage -- usage:stats
```

The line to read is the retention check. `OK` means no record past the
personal-data boundary still holds an IP or a user agent. `NOT COMPLIANT` means
we are publicly committed to something we are demonstrably not doing, and
`usage:retention` is the fix. It should never say `NOT COMPLIANT`; if it does,
find out how long it has, because that is the answer a regulator would want.

---

## 4. Why the invoice is a separate record

**ABL-297 §9(2).** The monthly aggregate is *materialised* in `usage_rollup`, and
an invoice is raised from that table and never from a scan of `usage_events`.

The failure this avoids is specific and cannot be fixed retroactively. If an
invoice were computed by scanning raw request rows, then the deletions in §3 —
which we publish, and which are correct — would destroy the ability to
reconstruct or defend an invoice from eight months ago. The system would work
perfectly for its first year and then start answering "zero" for exactly the
months somebody is disputing. Nobody discovers that until the first dispute, and
by then it is unfixable.

So:

- Aggregates are written continuously (every minute) and are keyed
  `(account, key, UTC month)`.
- A month is **closed** explicitly once it is past its grace period and every one
  of its events is aggregated. Closing is idempotent and restart-safe.
- **A closed month is final.** An event that arrives for it afterwards increments
  `late_requests` / `late_billable_requests`, where an investigator can see it,
  and never changes a figure that may already have been invoiced.

Invoice from a **closed** month. `usage:month` warns when a month is still open,
because an open month can legitimately give two different answers a day apart.

---

## 5. Answering a subject access request

**ABL-297 §9(3): answerable in under a month, by one person, without a UI.**

### Procedure

1. **Identify the subject.** A request will arrive naming a person or a company.
   What this system holds is keyed to an **account**, so the first step is
   account id, not a search. `npm run keys -- accounts:list` lists them with
   names.

   If the requester cannot be tied to an account, say so and ask for the account
   name or a key prefix — a key prefix is the non-secret handle and is safe for a
   customer to send in an email.

2. **Verify the requester.** Not a technical step and not optional: an export
   contains IP addresses and usage history. Confirm they are who they say they
   are through the existing commercial relationship, not through the fact that
   they knew an account id.

3. **Export.**

   ```
   cd server
   npm run usage -- usage:export --account acct_XXXX --out acct_XXXX-export.json
   ```

   That produces one JSON file with three sections: `keys` (every key ever issued
   to the account, minus the secret hash), `events` (every request record still
   held — so up to 13 months, with IPs on the last 90 days), and `rollups` (every
   monthly aggregate, including closed months).

4. **Check it before it leaves.** Two things: that it contains no
   `secret_sha256` (it cannot — the export names its columns explicitly and a
   test asserts this), and that the account id in the file is the one you meant.

5. **Send it over an encrypted channel.** It is personal data. The CLI prints
   this reminder every time it writes a file, deliberately.

6. **Record that you did it**, with the date and the account, wherever the
   commercial relationship is recorded.

### Time

Steps 3 and 4 are seconds. The month in the commitment is for steps 1, 2 and 6,
which is the right place for it.

### What the export does not cover

This is `/v1` usage data only. If the person also exists in an email thread, a
CRM, or the ABL-297 contract documents, those are separate sources and this
procedure does not reach them. Say so explicitly when answering, rather than
implying the JSON file is everything.

### Erasure

There is no `usage:delete-account` command, and that is deliberate rather than
missing. An erasure request against usage records collides directly with the
seven-year obligation to keep the figures an invoice was based on, and the answer
is a judgement about which obligation wins for that record — not a command
anybody should be able to run in one line. If an erasure request arrives, raise
it; the retention job already removes the personal-data fields on the schedule we
published, which is usually the substance of what is being asked for.

---

## 6. Where to change what

| To change | Edit | Then |
|---|---|---|
| A retention period | `server/.env.public` | Update the ABL-297 privacy notice §5. It is a published number. |
| Which query parameters are logged | `LOGGED_QUERY_PARAMETERS` in `usageStore.ts` | Read §2 first. Adding a name is the risky direction. |
| What counts as billable | `isBillableStatus` in `usageStore.ts` | It is a named function so that changing it is a diff somebody reviews. |
| The idempotency window or cap | `usageStore.ts` constants | Both bound how much we *under*-bill; check the direction before moving either. |
| How often retention runs | `usageMaintenance.ts` constants | The periods are in days, so this only changes how promptly a boundary is acted on. |
