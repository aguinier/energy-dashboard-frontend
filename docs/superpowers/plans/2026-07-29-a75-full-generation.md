# A75 Full Generation Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the nuclear and fossil generation the ENTSO-E A75 document already returns, instead of discarding it, so the dashboard can say what is actually generating rather than showing an unnamed remainder.

**Architecture:** A75 is already fetched with `psr_type=None` (all production types). `_map_renewable_columns` then narrows the response to 8 renewable columns and drops the other 10 types. This plan adds a second mapping that keeps everything, a new `energy_generation` table holding the **complete** document, and a resumable backfill. `energy_renewable` keeps being written by the same unchanged mapping so no existing consumer breaks — both tables are populated from **one** API call, never two.

**Tech Stack:** Python 3 + `entsoe-py` + pandas, SQLite (better-sqlite3 on the read side); Express + React/TypeScript for the dashboard. Ingest runs in Docker on prod (`QuietlyConfident`, 192.168.86.36) under cron; the workstation holds a read-only replica.

## Global Constraints

- **Never display a number the database does not contain.** A production type absent from a country's A75 response is `NULL`, not `0` — the two are different claims and the UI must render the gap.
- **One A75 fetch, two writes.** Never query ENTSO-E twice for the same document to fill the two tables.
- **`energy_renewable` behaviour is frozen.** Its mapping, columns and row values must not change — the frontend, the forecast job and several backfill scripts read it. This plan only adds alongside it.
- The prod DB at `192.168.86.36:/data/energy_dashboard.db` is **canonical**. The workstation copy at `C:/Code/able/data/energy_dashboard.db` is a **read-only replica** — never write it; only the sync script does.
- Deploys: `git push` → `ssh clavain@192.168.86.36` → `git pull` → `docker compose build` → `docker compose up -d --force-recreate` (see `C:/Code/able/WORKFLOWS.md`). SSH user is `clavain`, not `guill`.
- Long backfills run under `nohup`/`tmux` on the host — `docker exec` dies with the SSH session.
- Server tests mock the DB with `vi.mock('../config/database.js', () => ({ default: null }))`. Client is **vitest only** — no jsdom, no testing-library; extract pure functions to test them.

## Established facts (measured — do not re-derive)

| | |
|---|---|
| A75 is already fetched | `entsoe_client.py:1032`, `psr_type=None` |
| Types discarded today | Nuclear, Fossil Gas, Fossil Hard coal, Fossil Brown coal/Lignite, Fossil Oil, Fossil Oil shale, Fossil Peat, Fossil Coal-derived gas, Waste, Other |
| France returns | Nuclear, Fossil Gas, Fossil Oil, Waste (+ renewables) |
| Union across DE/PL/ES | 21 production types |
| `energy_renewable` | 795,541 rows, **2021-01-01** → now, 34 countries |
| Replica sync | auto-discovers tables (Stage 2 exports all) — **no sync change needed** |
| Backfill resumability | `smart_backfill.py` already skips months that have data |

---

## Phase 1 — capture

### Task 1: Create the `energy_generation` table

**Files:**
- Create: `energy-data-gathering/scripts/create_generation_table.py`
- Modify: `energy-data-gathering/src/db.py` (schema constant, if one exists — check before adding)

**Interfaces:**
- Produces: table `energy_generation` with `(country_code, timestamp_utc)` unique, one `REAL` column per production type, all defaulting to `NULL` (**not** `0` — see Global Constraints), plus `data_quality`, `fetched_at`, `publication_timestamp_utc`.

- [ ] **Step 1: Mirror the existing shape, with NULL defaults**

Follow `energy_renewable`'s column conventions (`*_mw`, `country_code`, `timestamp_utc`, `data_quality`, `fetched_at`, `publication_timestamp_utc`) but **do not** copy its `DEFAULT 0`. A country that does not report nuclear must read `NULL`, not `0` — `0` is a measurement claim.

```sql
CREATE TABLE IF NOT EXISTS energy_generation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    timestamp_utc TIMESTAMP NOT NULL,

    -- renewables (same semantics as energy_renewable, repeated so this table
    -- holds the whole A75 document and needs no join to be useful)
    solar_mw REAL,
    wind_onshore_mw REAL,
    wind_offshore_mw REAL,
    hydro_run_mw REAL,
    hydro_reservoir_mw REAL,
    hydro_pumped_mw REAL,
    biomass_mw REAL,
    geothermal_mw REAL,
    marine_mw REAL,
    other_renewable_mw REAL,
    energy_storage_mw REAL,

    -- everything the old mapping discarded
    nuclear_mw REAL,
    fossil_gas_mw REAL,
    fossil_hard_coal_mw REAL,
    fossil_brown_coal_mw REAL,
    fossil_oil_mw REAL,
    fossil_oil_shale_mw REAL,
    fossil_peat_mw REAL,
    fossil_coal_derived_gas_mw REAL,
    waste_mw REAL,
    other_mw REAL,

    data_quality TEXT DEFAULT 'actual',
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    publication_timestamp_utc TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_country_time
    ON energy_generation(country_code, timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_generation_time
    ON energy_generation(timestamp_utc);
```

Note `hydro_pumped_mw` is its own column here, unlike `energy_renewable` which folds pumped storage into `hydro_reservoir_mw`. Pumped storage is a store, not a source, and can be negative — keeping it separate is why this table exists. **Do not** change `energy_renewable`'s folding behaviour.

- [ ] **Step 2: Verify against the replica, then apply to prod**

Run the script against a scratch copy first — never the replica, never prod, until it is proven:
```bash
cp C:/Code/able/data/energy_dashboard.db "$SCRATCH/schema_test.db"
ENERGY_DB_PATH="$SCRATCH/schema_test.db" python scripts/create_generation_table.py
```
Confirm the table and both indexes exist and `energy_renewable` is untouched.

- [ ] **Step 3: Commit**

```bash
git add scripts/create_generation_table.py src/db.py
git commit -m "feat(schema): add energy_generation for the full A75 document"
```

---

### Task 2: Map every production type

**Files:**
- Modify: `energy-data-gathering/config.py` (a full PSR/column map alongside the renewable one)
- Modify: `energy-data-gathering/src/entsoe_client.py` (new `_map_generation_columns`; leave `_map_renewable_columns` alone)
- Test: `energy-data-gathering/tests/test_generation_mapping.py` (create)

**Interfaces:**
- Produces: `ENTSOEClient.query_generation_all_types_with_metadata(country_code, start, end) -> (DataFrame, publication_time)` returning one column per `energy_generation` column, `NaN` where a type is absent.

- [ ] **Step 1: Write the failing test**

The ENTSO-E column names are known (measured live). Test the pure mapping with a synthetic frame — no network:

```python
def test_keeps_nuclear_and_fossil():
    df = pd.DataFrame({
        'timestamp_utc': [pd.Timestamp('2026-07-29T00:00:00Z')],
        'Nuclear': [42000.0],
        'Fossil Gas': [3000.0],
        'Solar': [0.0],
    })
    out = client._map_generation_columns(df)
    assert out['nuclear_mw'].iloc[0] == 42000.0
    assert out['fossil_gas_mw'].iloc[0] == 3000.0

def test_absent_type_is_null_not_zero():
    """A country that does not report coal must read NULL, not 0 - the two are
    different claims and the dashboard renders them differently."""
    df = pd.DataFrame({'timestamp_utc': [pd.Timestamp('2026-07-29T00:00:00Z')], 'Nuclear': [1.0]})
    out = client._map_generation_columns(df)
    assert pd.isna(out['fossil_hard_coal_mw'].iloc[0])

def test_reported_zero_stays_zero():
    """Solar at night is a measured 0, not missing data."""
    df = pd.DataFrame({'timestamp_utc': [pd.Timestamp('2026-07-29T00:00:00Z')], 'Solar': [0.0]})
    out = client._map_generation_columns(df)
    assert out['solar_mw'].iloc[0] == 0.0
    assert not pd.isna(out['solar_mw'].iloc[0])
```

That third test is the one that matters most and is easiest to break — `fillna(0)`, which the renewable mapping uses, would destroy the distinction.

- [ ] **Step 2: Run it, confirm it fails**

`python -m pytest tests/test_generation_mapping.py -q`

- [ ] **Step 3: Implement the mapping**

Add to `config.py` a `GENERATION_COLUMN_MAP` covering all 21 measured names → the Task 1 columns. The full list of ENTSO-E names, measured live:

`Biomass, Energy storage, Fossil Brown coal/Lignite, Fossil Coal-derived gas, Fossil Gas, Fossil Hard coal, Fossil Oil, Fossil Oil shale, Fossil Peat, Geothermal, Hydro Pumped Storage, Hydro Run-of-river and poundage, Hydro Water Reservoir, Marine, Nuclear, Other, Other renewable, Solar, Waste, Wind Offshore, Wind Onshore`

Implement `_map_generation_columns` **without** `fillna(0)` — absent columns stay `NaN` so they land as SQL `NULL`. Log any ENTSO-E column name not in the map at WARNING rather than silently dropping it; a new production type appearing upstream must be visible, which is exactly how the current code lost nuclear.

- [ ] **Step 4: Confirm green, then commit**

```bash
git add config.py src/entsoe_client.py tests/test_generation_mapping.py
git commit -m "feat(entsoe): map every A75 production type, not just renewables"
```

---

### Task 3: Write both tables from one fetch

**Files:**
- Modify: `energy-data-gathering/src/fetch_renewable.py`
- Modify: `energy-data-gathering/src/db.py` (add `upsert_generation_data`)
- Test: extend `tests/test_generation_mapping.py`

**Interfaces:**
- Consumes: `query_generation_all_types_with_metadata` from Task 2
- Produces: `db.upsert_generation_data(df, country_code, publication_timestamp)` → `(inserted, updated)`, upserting on `(country_code, timestamp_utc)`

- [ ] **Step 1: Fetch once, derive both**

`fetch_renewable_data` currently calls `query_generation_per_type_with_metadata`. Change it to call the all-types query **once**, write `energy_generation` from the full frame, and derive the `energy_renewable` frame from that same response rather than issuing a second request.

The derived renewable frame must be **byte-identical** to what the old path produced — same columns, same folding of pumped storage into `hydro_reservoir_mw`, same `fillna(0)`. Add a test asserting old and new paths agree on a synthetic frame covering all 21 types. If they disagree anywhere, stop and report rather than accepting the drift.

- [ ] **Step 2: Verify no extra API call**

Confirm by reading, and state in your report, that exactly one `_make_request` for generation happens per country per window.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(ingest): populate energy_generation from the same A75 fetch"
```

---

### Task 4: Resumable full-history backfill

**Files:**
- Create: `energy-data-gathering/scripts/backfill_generation.py`

**Interfaces:**
- Produces: CLI `python scripts/backfill_generation.py [--countries ALL|FR,DE] [--start 2021-01-01] [--dry-run]`

- [ ] **Step 1: Follow the existing pattern**

Model it on `scripts/smart_backfill.py`, which already skips months that have data — that is what makes it resumable. Iterate country × month, skip any month already populated in `energy_generation`, fetch, upsert. Rely on the client's built-in `_rate_limit`; do not add a second throttle.

Scope: 34 countries × 2021-01-01 → now ≈ **5.5 years**, so roughly 2,200 country-months. This will run for hours. It must survive being killed and resumed.

- [ ] **Step 2: `--dry-run` first**

Print the country-months it would fetch and the count, touching neither ENTSO-E nor the DB. Verify the plan looks right before any real run.

- [ ] **Step 3: Prove resumability on one country**

Run for a single country and a narrow window against a **scratch copy** of the replica. Kill it mid-run. Re-run. Confirm it resumes without duplicating rows and the unique index holds.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(backfill): resumable full-history backfill for energy_generation"
```

---

## Phase 2 — show it

### Task 5: Serve generation by type

**Files:**
- Create: `energy-dashboard-frontend/server/src/services/generationService.ts`
- Modify: `energy-dashboard-frontend/server/src/routes/renewables.ts` (or a new `generation.ts` — follow whichever fits the existing router shape)
- Test: `server/src/services/generationService.test.ts`

- [ ] **Step 1: Query `energy_generation`, never functions on indexed columns**

Filter on `country_code` and `timestamp_utc` directly. Wrapping `timestamp_utc` in `date()`/`strftime()` in a `WHERE` or `JOIN` defeats the index — that exact mistake cost 51s per 30-day query until it was fixed in `renewableService`. Grouping by those functions is fine.

- [ ] **Step 2: `NULL` must survive to the wire**

A type a country does not report is absent, not zero. Do not `COALESCE(x, 0)`. The client renders the difference.

- [ ] **Step 3: Commit**

---

### Task 6: Show real nuclear and fossil on the Generation tab

**Files:**
- Modify: `client/src/components/dashboard/sourceRows.ts`
- Modify: `client/src/components/dashboard/GenerationTab.tsx`, `SourceTable.tsx`
- Test: extend `client/src/components/dashboard/sourceRows.test.ts`

- [ ] **Step 1: Replace the unattributed remainder with measured rows**

`buildSourceRows` currently returns measured renewables plus an unnamed `unattributedMw`, because nuclear and fossil were unavailable. With real data, emit them as rows. Keep a remainder row only for what genuinely remains unexplained, and keep it honestly labelled.

Preserve the two behaviours already established here: the donut renders only when the remainder is non-null (a null load must never read as `100% RENEWABLE`), and the cards gate on the query's loading state rather than rendering zeros.

- [ ] **Step 2: Remove the now-obsolete footnote**

`SourceTable` carries "Nuclear and fossil generation are not ingested — the remainder is left unnamed." Once they are ingested that is false. Replace it with whatever is then true, per country.

- [ ] **Step 3: Commit**

---

## Phase 3 — ship

### Task 7: Deploy and run the backfill

- [ ] **Step 1: Deploy the ingest**, apply the schema on prod, confirm the next scheduled run populates `energy_generation` going forward.
- [ ] **Step 2: Start the backfill under `nohup`**, logging to a file. Do not hold it on the SSH session.
- [ ] **Step 3: Check progress periodically** — row counts per country per year — rather than tailing for hours.
- [ ] **Step 4: Deploy the dashboard** once enough history exists for the reachable windows (24h/7d/30d need only recent data; the backfill can still be running).
- [ ] **Step 5: Verify** France shows real nuclear rather than an unattributed block, and that a country not reporting a type shows a gap rather than a zero.

---

## Out of scope

- **Retiring `energy_renewable`.** Once `energy_generation` is populated and consumers migrate, the older table is redundant — but that is a separate migration with its own blast radius (frontend service, forecast job, backfill scripts).
- **Forecasting the new types.** This plan captures actuals only.
- **`publication_timestamp_utc` on `net_position`** — still NULL across 640k rows; unrelated but adjacent, and worth doing while the ingest is being touched.
