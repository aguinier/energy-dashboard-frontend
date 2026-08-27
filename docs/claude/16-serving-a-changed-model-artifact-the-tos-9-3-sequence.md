> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# Serving a changed model artifact: the ToS §9.3 sequence

## Serving a changed model artifact: the ToS §9.3 sequence

ABL-528, ABL-529 and ABL-532 shipped three mechanisms. §9.3 is kept only if they
are used in the right order, on the same day. This is that order.

**Status, 2026-08-22:** nothing is published, no external API key exists, ABL-349
forbids issuing one. No §9.3 clock is running today. This is the procedure for the
first day one is.

### The test that starts it

§9.3.1, Board-confirmed 2026-08-22:

> A model change is **material** if a request you made yesterday, repeated unchanged
> today, would return different forecast values under the same `model` label.
> Beginning to serve a combination we did not serve before is **not**.

The second sentence does as much work as the first. `/v1` labels a model by
*family* — `catboost`, `xgboost` — while the artifact identity is
`forecasts.model_version`, which appears on no response. Retraining behind a pair
we already serve moves every number under an unchanged label. That is the material
case, and it is invisible from outside.

| Situation | Procedure | Clock |
|---|---|---|
| Retrained artifact for a `(zone, forecast_type, model)` triple **already in the ledger** | **A** | 30 days before it may serve |
| The values we are serving are **wrong**, and the change corrects them | **B** | none — entry goes up when the fix serves |
| A combination we have **never** served | **C** | none — nothing to do |
| We **stop** covering a zone a model covered | **D** | material, and nothing enforces it |

### Procedure A — planned material change (30 days)

Order matters: the ledger record is written first because the change-log entry is
written *from* it, and the 30-day clock is the record's `serve_from`.

**1. See it.**

```bash
cd server
npm run modelversions -- status
```

Exit 1 with an unacknowledged list means the database holds a version no human has
signed. Nothing is breached and there is no rush of hours — the guard is already
withholding it and subscribers are getting the previously acknowledged artifact.

**2. Draft the record.**

```bash
npm run modelversions -- draft --kind material --by "<a role, a human>" \
    --note "<what changed and why, in a sentence a subscriber can read>"
```

It prints and writes nothing. That is deliberate: a command that edited the ledger
would make "acknowledged" mean "somebody ran a script".

**3. Sign it.** Paste the block into
`server/src/v1/modelVersions/acknowledgements.ts`, open a PR, CEO merges. **The
reviewed merge is the signature.** `assertLedgerWellFormed` refuses a `material`
record whose `serve_from` is less than 30 days after `acknowledged_at`, so the
clause is enforced by the file rather than remembered by whoever edits it.

**4. Publish the notice — the same day you merge.**

```bash
npm run changelog -- entries:publish --type planned \
    --effective "<serve_from, verbatim from the record>" \
    --title "..." --detail "..."
```

`--effective` **must equal the record's `serve_from`.** If they disagree, the page
says one thing and the server does another, and the subscriber is entitled to the
earlier of the two. A `planned` entry is refused unless it is effective at least 30
days out — the same rule as step 3, enforced a second time on purpose, because
these are two different files that can drift.

**The clock runs from publication, not from the merge.** The store stamps
`published` at insert and has no parameter that could backdate it. Merge and publish
on the same day and the question never arises.

**5. Notify the account contact — the same day.**

```bash
npm run keys -- keys:contacts
```

Two halves, and it prints both even when the second is empty: the recipient list,
and **every live key with no address**. If the second half is non-empty, **stop** —
those subscribers are owed the same notice and cannot be reached. Then **send the
mail by hand**; see *The one manual step* below.

**6. The cutover needs no deploy.** The gate is built per request. At `serve_from`
both the old and new versions become servable and `MAX(generated_at)` picks the
newer rows. Do not delete the superseded record — during the 30 days it is what
keeps the series alive, and the ledger is the audit trail of every version that
ever reached a subscriber.

### Procedure B — correction (§9.3.2, immediate)

§9.3.2 exempts a fix for values that are *wrong* from the 30 days. It does **not**
exempt it from the change log, and it does not exempt it from the contact.

1. `npm run modelversions -- draft --kind correction --by "<role>" --note "<what was wrong>"` — refuses without a note, because that note is the entry's `--what-was-wrong`.
2. Merge the record. `serve_from` may equal `acknowledged_at`.
3. **At the moment it serves:**

   ```bash
   npm run changelog -- entries:publish --type correction --effective "<instant>" \
       --title "..." --detail "..." --what-was-wrong "..."
   ```

   A correction effective more than an hour ahead is **refused** — that is a planned
   change wearing a correction's label to escape the notice period. Publishing *late*
   is warned about and not refused: by then the change is already being served, and
   refusing the entry would trade a late notice for no notice.
4. `keys:contacts`, and send, the same day.

**Use `correction` only when the values being served are wrong.** "Better" is not
"wrong" — a retrain that improves accuracy is Procedure A. The live case this path
exists for is the NL gross-basis load forecast (ABL-501 / ABL-505 / ABL-506).

### Procedure C — additive (nothing to do)

A triple absent from the ledger serves unfiltered. That is ruling A1 expressed as
data rather than as a flag somebody has to set correctly, and it is why the guard
costs nothing until the first retrain of an existing pair. **ABL-525's eight new
pairs are exactly this.**

Do not draft an acknowledgement for a new combination. Adding one puts a pair under
the guard that §9.1 says may ship at any time.

### Procedure D — withdrawal, which nothing enforces

§9.3.1's M4 makes it material to stop covering a zone a model covered. A read-side
guard has no rows to filter, so it **cannot** withhold a withdrawal: `npm run
modelversions -- status` reports it as `triple_gone` and that is the end of what
the machine will do.

If you are removing coverage, Procedure A applies in full and **only your discipline
enforces it.**

### The one manual step, named

**Nothing in this repository sends mail.** `accountContacts.ts` produces the
recipient list; there is no transport. So step 5 of A and step 4 of B are a human
sending an email from what `keys:contacts` prints.

That is a bounded choice, not an oversight:

- ABL-528 **refuses to mint a key without a contact**, so every key issued from now
  on is reachable, and the "no address" half of the output is the standing check
  that the promise is keepable.
- No external key exists today, so the list is empty and the first notice will go to
  a list a person can read in one sitting.

**Review trigger:** when the recipient list would take more than one sitting to send
by hand — call it **20 live keys** — mechanising delivery becomes cheaper than the
risk of a half-sent notice. File it then, not before.

### What breaks if a step is skipped

| Skipped | What a subscriber gets | What catches it |
|---|---|---|
| Draft / sign (2–3) | Nothing changes — the old artifact keeps serving. **Fails safe.** | `modelversions -- status`, exit 1 |
| Change log (4) | Numbers move on `serve_from` with no published notice. **§9.3 breached.** | **Nothing.** |
| Account contact (5) | Same breach, second channel. | `keys:contacts` shows who was owed it; nothing checks it was sent. |
| The whole procedure — hand-editing `acknowledgements.ts` under time pressure and merging | Full silent breach | **Nothing.** The PR review is the only check. |

The two unprotected steps are **4 and 5**. The guard cannot enforce them: it lives
in the read path and knows nothing about publication. That is precisely why this is
a runbook and not a test, and why it belongs in `CLAUDE.md` where a reviewer will
see it before approving a change to `acknowledgements.ts`.
