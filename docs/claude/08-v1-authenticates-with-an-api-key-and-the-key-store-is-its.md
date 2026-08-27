> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# `/v1` authenticates with an API key, and the key store is its own database

## `/v1` authenticates with an API key, and the key store is its own database

ABL-300. `Authorization: Bearer able_<env>_<prefix>_<secret>` — for example
`able_live_7f3a9c21_xR4k…`. Four `_`-separated segments, each of which earns
its place: a fixed `able` namespace so a leaked key is attributable and
greppable, a `live`/`test` environment, an **8-character non-secret prefix**
stored in clear, and the secret.

`middleware/writeAuth.ts` is untouched and keeps gating the two ingest `POST`s
on the private app. It could not be the public mechanism, for reasons that are
structural rather than a matter of hardening (ABL-293 §2b): it is **one shared
secret** compared with `!==` against `HELIO_WRITE_TOKEN`
(`middleware/writeAuth.ts:27`), so there is no identity, therefore no
attribution, therefore nothing ABL-301 could meter; there is no revocation
short of breaking every caller at once; and `!==` on a secret is a timing
oracle. Its own comment says it is LAN-only.

**Nothing stores a raw key.** `mintApiKey`
(`server/src/v1/keys/keyFormat.ts:204`) returns the key string once, and the
store persists `sha256(secret)` and the prefix — there is no column that could
hold a key, and `sqliteApiKeyStore.test.ts` asserts that against the database
file's bytes rather than against the schema. SHA-256 rather than bcrypt or
argon2 is correct *here specifically*, which is the opposite of the usual
advice and so is written down: the secret is 43 base62 characters of CSPRNG
output — about 256 bits — so there is nothing to brute-force, and a slow KDF
would put tens of milliseconds on the critical path of every request for no
benefit. Same reason there is no salt. Verification is a prefix lookup plus
`crypto.timingSafeEqual`, and an unknown prefix burns a comparison anyway
(`burnSecretComparison`) so the non-secret handle is not an enumeration oracle.

**Where the records live: a second SQLite file at `API_KEYS_DB_PATH`, never the
energy database.** That file is 376 GiB, is owned by `energy-data-gathering`
and is opened readonly here (`config/database.ts:11`); writing accounts and
keys into it would mean a write path contending with ingest, in a schema we do
not own, and would undo the property ABL-304 established — that the public
process holds no write handle on energy data. `resolveApiKeysDbPath`
(`server/src/v1/keys/sqliteApiKeyStore.ts:89`) refuses to start when the two
paths resolve to the same file, and refuses `config/database.ts`'s literal
default too. There is no default for `API_KEYS_DB_PATH` itself, because a
credentials file must not land somewhere nobody chose. ABL-301's
`usage_events`/`usage_rollup` belong in this same file and are deliberately not
created yet.

Two capabilities over that file, split at the type *and* at the file handle:

- `openApiKeyDirectory` opens it **readonly** and returns `findByPrefix` and
  nothing else. This is what `publicIndex.ts` gives `createPublicApp`, so the
  serving process cannot alter a key record — not a check that returns false,
  an operating-system-level one.
- `openApiKeyAdminStore` opens it read-write and is reached only from the keys
  CLI. `publicAppGraph.test.ts` asserts by name that neither entrypoint can
  reach `keysCli.ts` or the test-only `memoryApiKeyDirectory.ts`, and that
  `better-sqlite3` is imported by exactly one module in the entrypoint's graph.

**The gate covers paths, not routes.** `publicApp.ts` mounts three things in
order: `v1/routes/root.ts` (the entire unauthenticated surface — one discovery
endpoint returning two constants), then `requireApiKey`, then
`v1/routes/index.ts`. So `/v1/anything` answers **401 rather than 404** without
a key — the surface cannot be enumerated, and a resource ABL-303 adds to
`routes/index.ts` is authenticated whether or not its author thought about it.
CORS sits ahead of the gate deliberately: `cors` answers a preflight itself,
and a preflight carries no `Authorization` header by specification. Handlers
read the caller with `requireApiPrincipal`
(`server/src/v1/auth/apiKeyAuth.ts:95`), which **throws** rather than returning
`undefined` — a route mounted on the wrong side of the gate fails loudly the
first time it is exercised instead of being metered to nobody.

Six refusal codes, each a distinct `error.code`: `key_missing`,
`key_malformed`, `key_invalid`, `key_revoked`, `key_expired` (all 401) and
`account_disabled` (403 — the credential is good, so telling the customer to
check their key would be the wrong afternoon to spend). The specific ones are
not an information leak: revoked, expired and disabled are reachable **only
after** the presented secret has matched the stored hash, so someone guessing
keys sees nothing but `key_invalid`. Every message is a constant — nothing
interpolates the key, the prefix or an account name — because a 401 body is the
single most likely thing a customer pastes into a public tracker.

Keys are issued by an operator, not by an endpoint. There is no `POST /v1/keys`
until there is an account model, an identity provider and a payment
relationship, none of which exist:

```bash
cd server                        # reads server/.env.public — see .env.public.example
npm run keys -- accounts:create --name "Acme Energy" --plan developer
npm run keys -- keys:issue --account acct_... --label "prod ETL" --contact ops@acme.example
npm run keys -- keys:contacts
npm run keys -- keys:rotate --key key_... --overlap-days 7
npm run keys -- keys:revoke --key key_... --reason "leaked in a support ticket"
```

Rotation is one atomic store operation, not "issue then remember to retire":
the sequence has two quiet failure states — a new key with the old never
retired, and an old key retired with no replacement. With an overlap the
outgoing key gets an `expires_at` so the customer can deploy before it stops;
`--overlap-days 0` revokes it immediately, which is what a suspected leak
wants. Revocation is **soft** — a `revoked_at` timestamp, never a row delete,
because ABL-301's usage records will point at the key id and a billing history
whose foreign key dangles is a dispute we cannot answer. An account holds at
most **5** live keys (`MAX_LIVE_KEYS_PER_ACCOUNT`); a rotation with an overlap
counts both while they overlap.

There is no `last_used_at`. It is the obvious column to want and it would cost
a write on the critical path of every authenticated request to maintain a field
nobody needs to the second; once ABL-301 lands it is a `MAX(received_at)` over
`usage_events`. An unused column invites someone to start filling it.

### A key carries the account contact, and one without it is refused (ABL-528)

**ToS §9.3 commits us to publishing a material model change "through the
changelog *and* to the account contact", and until this landed there was no
contact field anywhere** — not in `v1/billing`, not in `v1/keys`. Half of a
two-channel contractual notice resolved to nothing, and the way that fails is
the worst available: nobody finds out until a model changes.

The obvious reading is "wait for the account model". That is what makes it fail.
The thing issued today **is** a key, issued to somebody by a human running
`keysCli` — so the address goes on the record that already exists
(`ApiKeyRecord.contactEmail`), not on an account model with no scheduled date.
It also gives the field a natural enforcement point: a key with no contact is a
subscriber we have promised to notify and cannot reach.

Four properties, and the last two are the ones a re-reader will want:

- **Required at issuance, nullable in the column.** `IssueKeyInput.contactEmail`
  is a required `string`, so omitting it is a compile error **in production
  code**; `insertMintedKey` additionally calls `requireContactEmail`, because a
  flag, a JSON payload or a cast are paths a type cannot see. The *column* is
  nullable because SQLite cannot `ADD COLUMN … NOT NULL` without a default and
  every candidate default here is a fabricated address. `null` is reachable only
  from a row written before the column existed.

  **"Compile error" is narrower than it sounds, and the runtime guard is not
  belt-and-braces — it is the only guard on a whole class of call site.**
  `server/tsconfig.json` excludes `src/**/*.test.ts`, so **no test file is
  typechecked**, and a test minting a contactless key compiles clean with
  `tsc --noEmit` at exit 0. That is not hypothetical: merging ABL-530 in brought
  `security/sqliteAuthFailureStore.test.ts`, which mints a key to build its
  fixture, and all 36 of its cases failed in setup on `requireContactEmail` with
  nothing to warn them at build time. If that guard is ever removed as
  redundant-to-the-type, every test becomes a path that can write a contactless
  key — and tests are where fixtures get copied from.
- **Both doors, not just the obvious one.** `issueKey` and `rotateKey` are two
  ways into one room, and both funnel through `insertMintedKey`, which is where
  the refusal lives. A rotation carries the retiring key's contact forward — a
  rotation is the same subscriber with a new secret — so `--contact` is needed
  there only to change it.
- **Existing rows are left null and reported as unreachable, never backfilled.**
  `collectAccountContacts` (`server/src/v1/keys/accountContacts.ts`, pure,
  colocated test) returns `{ recipients, unreachable, liveKeys }` and
  `keys:contacts` prints **both halves, always** — including "Every live key has
  a contact" when the second is empty, because a report that goes quiet when
  nothing is wrong cannot be told from one that has stopped checking. The
  tempting shape is a `string[]` of addresses, which silently drops every
  contactless key and hands the sender a list that looks complete. Rotating such
  a key with `--contact` is the migration path, and it is deliberately a human
  decision. A placeholder would be an address a notice is "sent" to and lost —
  an address we cannot deliver to wearing the costume of one we can, which is
  this repository's defining defect applied to a contractual notice.
- **Two modules name `contact_email` in SQL and only one of them can migrate**,
  so both degrade rather than fail. The readonly serving handle cannot run the
  migration, and naming a column that is not there fails at `prepare` — a server
  pointed at a pre-ABL-528 file would refuse to authenticate *every customer*
  over a notice address no authentication path reads. `lookupSql` selects a
  literal `NULL` instead when the column is absent, and
  `sqliteUsageStore.exportAccount` does the same through the **same** exported
  guard (`hasContactEmailColumn`), not a second copy of it: that module opens
  the file read-write but confines its DDL to the three usage tables and only
  checks that `api_keys` *exists*, so it meets the identical file shape. Its
  prepare is lazy, which is what makes the omission expensive rather than
  obvious — nothing fails at open, and the throw lands on the one command whose
  whole job is to be answerable on demand, a subject access request. Verify with
  `grep -rn "FROM api_keys" server/src --include=*.ts`: the other three reads are
  `SELECT *` inside the admin store, which migrates and cannot name a missing
  column anyway.

Scope is live keys: a revoked or expired key's holder is not a subscriber §9.3
owes a notice to. `liveKeys` rides along so "0 recipients" can be told apart from
"0 keys". The plausibility check on the address is a **typo-catcher, not a proof
of validity** — deliverability is only ever established by delivering, which is
ABL-529's problem. **Nothing here sends anything.**

Not done by ABL-300: quotas, rate limits and the 429 contract (ABL-302), and the
resources themselves (ABL-303). The `plan` on the principal is carried for
ABL-302 to enforce and nothing here branches on it — that issue authenticates and
identifies a caller, it does not meter one. Metering is ABL-301, below.
