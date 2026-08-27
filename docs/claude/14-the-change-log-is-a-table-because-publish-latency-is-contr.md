> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# The change log is a table, because publish latency is contractual

## The change log is a table, because publish latency is contractual

ABL-532. `server/src/v1/changelog/` serves `/changelog` and `/changelog.json`,
and the two decisions worth knowing before touching it are **where the URL is**
and **why entries are not files**.

**Entries are rows, not source.** ToS §9.3 commits us to publishing a material
model change 30 days ahead; §9.3.2 lets a change that corrects *wrong* values be
served immediately, with its entry published **at the same time as the change**.
That makes publish latency a contractual property. This repository has no CI/CD
and production is updated by hand (see **Deployment** above), so a change log
whose entries were committed files would publish whenever somebody next
deployed — we would serve the correction instantly and publish the required
notice hours or days later. Publishing is instead:

```bash
cd server
npm run changelog -- entries:publish --type correction --effective 2026-08-22T14:00:00Z \
    --title "..." --detail "..." --what-was-wrong "..."
```

measured at **under half a second**, and the serving process picks the row up on
its next request. Nothing to rebuild, nothing to restart. The cost, which is
real: entry prose is typed at a terminal rather than reviewed in a diff. Three
things bound it — publication is stamped by the store and has no parameter that
could backdate it, there is **no update and no delete** anywhere in the module,
and every rule the Terms put on the two instants is enforced at insert.

**The URL is deliberately outside `/v1`.** §9.3 also commits us to giving six
months' notice before retiring a major API version, *through this change log* — a
change log at `/v1/changelog` would be withdrawn by the very event it exists to
announce. It is unauthenticated, and it is the second thing on this surface that
is, after the discovery root; `requireApiKey` still covers every path under `/v1`
including `/v1/changelog`, which answers 401 like any other.

**Two instants per entry, and a type that is enforced against them.** `published`
and `effective`, ISO-8601 UTC, because 30 days' notice is a *duration* and "at the
same time" is a claim about an *instant* — a date column can express neither
without a convention nobody wrote down. A `planned` entry is refused unless it is
effective at least 30 days out; a `correction` is refused if it is effective more
than an hour ahead, because that is a planned change wearing a correction's label
to escape the notice period. Publishing a correction **late** is warned about and
not refused: by then the change is already being served, so refusing the entry
would trade a late notice for no notice. Entries render newest-first by
*publication*, never by effective instant — an entry never moves once published.

**It renders nothing and cites nothing.** No stylesheet, script, font, image or
favicon: the composition already sends `default-src 'none'`, so adding CSS would
mean widening the one header that makes ABL-522's no-third-party-assets
constraint a property of the deployment. No Terms link and no clause number
either, for the same reason `GATED_INFO_FIELDS` withholds `termsOfService` — a
citation points a reader at a document they cannot open while ABL-349 is holding
publication. The page explains both dates and both types in its own words, and
`changelog/changelogHtml.test.ts` asserts both properties against the rendered
bytes.

**Not live.** Built, tested and merged; the public process still binds loopback,
is not deployed, and the change log is linked from no index — not the discovery
root, not the OpenAPI document. `entries:seed --examples` installs two example
entries that describe no real change and say so loudly on the page; do not seed
them into a store that serves real subscribers.

**`npm run changelog -- entries:init` is how the store gets created, and the
distinction is not cosmetic.** Seeding is emphatically not the way: it publishes
two entries that give notice of nothing, and this module has no update and no
delete, so an operator who reaches for it once has published them permanently on
the page §9.3 points subscribers at. Both of `openChangelogReader`'s refusals
therefore name `entries:init` — a startup error is the one instruction an
operator is guaranteed to read, so it must not be the one that costs them that.
An **empty** change log is a healthy state and serves an empty page; only a
**missing** table refuses to start. `entries:init` is idempotent and publishes
nothing. It exists as a named command rather than as documentation of
`entries:list`'s side effect because `list` is a read, and later handing it the
readonly handle — the discipline applied everywhere else here — would silently
falsify a string printed in a startup error;
`changelog/changelogCli.test.ts` pins the operator's journey end to end (fresh
path → `entries:init` → the reader that was refusing now opens) rather than
pinning the wording.

The store is `changelog_entries` in the **same** SQLite file as keys and usage,
resolved through `resolveApiKeysDbPath` so the "never the energy database" guard
stays singular. It is the fourth module in the public graph to open a database,
and `publicAppGraph.test.ts` — which names a fourth as one of the three things it
exists to catch — carries the argument for it.
