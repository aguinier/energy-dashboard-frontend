# Net position on the dashboard — design

**Date:** 2026-07-26
**Status:** approved design, not yet implemented

## Goal

Display day-ahead net position per country, together with the Chronos-2 D+2
forecast that has been running on the workstation since 2026-07-25 and that
nothing currently consumes.

## Why this needs a design at all

Actuals and forecasts live on different machines.

| | Where | What |
|---|---|---|
| Actuals | prod `energy_dashboard.db`, table `net_position` | 22 countries, ~31k rows each, 2023-01-01 → now |
| Forecasts | **workstation** `forecasts_local.db` (sidecar) | 2,208 points + 19,872 quantile rows, 19 countries |

Prod's `forecasts` table holds load, price, solar, wind, hydro and biomass —
**no net position**. Prod has **no `forecast_quantiles` table at all**; that
table is created by `energy-forecast/src/db.py:194` and has only ever run
against the sidecar.

Since 2026-07-26 the acceptance dashboard proxies `/api` to prod, so anything
that is not in prod's database is invisible in both environments.

## Verified facts this design rests on

- **Sign convention: positive = exporter.** Documented at
  `energy-data-gathering/config.py:137`.
- **These are day-ahead values, not realized ones** (`dayahead=True`), so the
  "actual" series legitimately extends into the future once published.
- **DE is stored as DE_LU**, the Core CCR bidding zone covering Germany and
  Luxembourg (`ENTSOEClient.NET_POSITION_BIDDING_ZONES`). LU therefore has
  only 180 rows of its own.
- **GR and IE stop at 2026-03-14** — same date for both, cause not yet
  investigated.
- Forecast is **V010 zero-shot, target D+2**, 24 hourly points per country,
  generated 08:00 daily by `able-net-position-forecast`.

## Architecture

### Write path: workstation → prod

New route `POST /api/forecasts/net-position`, deliberately modelled on the
existing `POST /api/weather/snapshot`:

- same `writeAuth` middleware (Bearer `HELIO_WRITE_TOKEN`)
- same lazy `getWriteDb()` connection (never opened at import — see `ad99a19`)
- 503 when no token configured, 401 on bad token, 400 on invalid payload,
  413 over `MAX_ROWS`

Payload:

```json
{
  "model":  { "name": "chronos-2-V010", "version": "V010" },
  "generated_at": "2026-07-26T08:00:04Z",
  "rows": [
    { "country_code": "BE",
      "target_timestamp_utc": "2026-07-28T00:00:00Z",
      "horizon_hours": 40,
      "forecast_value": -57.2,
      "quantiles": { "0.1": -166.5, "0.2": -134.0, "0.5": -57.2,
                     "0.8": 21.4, "0.9": 56.1 } }
  ]
}
```

The model emits **9 quantiles per point** (19,872 quantile rows / 2,208 points).
All nine are stored; the chart uses only p10/p50/p90.

**Idempotency is required, not optional.** The write deletes then inserts per
`(country_code, forecast_type, model_name, generated_at)` inside one
transaction. Re-running the 08:00 job after a failure is expected operation;
duplicate rows would silently corrupt any later accuracy measurement.

The job keeps writing its sidecar first and POSTs afterwards, so
`sync-db-v2.ps1` remains the only writer of the workstation replica and
replica purity is preserved.

### Schema addition on prod

`forecast_quantiles` must be created on prod, using the exact DDL from
`energy-forecast/src/db.py`, including the `idx_fq_lookup` index. The endpoint
does this with `CREATE TABLE IF NOT EXISTS` on first write.

`forecasts` needs no change: prod's table is a superset of the sidecar's
(it has an extra `renewable_type`, left NULL for net position).

### Read path

One combined endpoint:

```
GET /api/net-position/:countryCode?start=&end=
  -> {
       actual:   [ { timestamp_utc, net_position_mw } ],
       forecast: [ { target_timestamp_utc, p10, p50, p90 } ],
       meta:     { model_name, model_version, generated_at, bidding_zone }
     }
```

Combined rather than split, so the chart has a single loading state for what is
visually one picture. The band is **nested into each forecast row as p10/p50/p90
rather than returned as a separate quantiles array** — the chart would otherwise
have to join two lists by timestamp on every render. The full nine-quantile set
stays in the database and is not exposed by this endpoint.

`meta.bidding_zone` is the zone actually queried, so DE and LU both report
`DE_LU` and the UI can say so without hardcoding the mapping.

## UI

A lazy-loaded `NetPositionTab`, following the existing `LoadTab` pattern, added
to the tab row in `CountryDashboardView`.

One chart, three regimes on a shared axis:

1. **Observed** — solid line, up to the last published hour.
2. **Published day-ahead** — same series, finer dash. Not a forecast: it is the
   market outcome, already known, and legitimately in the future.
3. **Chronos D+2** — dashed line plus a shaded p10–p90 band.

The **zero line is emphasised** with exporter/importer sides labelled. This is
the first two-sided metric in the app, and a net position chart without a
visible zero is unreadable.

Colours follow existing tokens — sky blue for the model forecast, matching the
ML-forecast convention already used elsewhere.

## Edge cases

These are where the feature will look broken if skipped.

- **The D+1 gap is normal, daily, and must render as a gap.** Tomorrow's
  day-ahead net position is not published until after market coupling
  (~13:00 CET). Before then there is genuinely no data between end-of-today and
  the D+2 forecast. Drawing a line across it would be fabricated data.
- **GR and IE** need an explicit "no data since 2026-03-14" state naming the
  date, not an empty chart that reads as a loading bug.
- **DE and LU** need a bidding-zone note: the figure shown is DE_LU, covering
  both countries.
- **Forecast provenance** — model version and `generated_at` shown via the
  existing `ForecastMetadataBadge`. A forecast on screen without its vintage is
  how a stale number gets trusted.

## Testing

TDD, per project practice.

Server:
- 503 without token, 401 with a wrong one
- payload validation (missing fields, bad types, over `MAX_ROWS`)
- **idempotency: posting the same run twice leaves the row count unchanged**
- `forecast_quantiles` created on first write against a DB lacking it
- read endpoint shapes, including a country with no rows

Client:
- three regimes render, and the D+1 gap stays a gap
- stale-country empty state for GR/IE
- bidding-zone note for DE/LU

## Build order

Steps 1–3 are workstation-only. Step 4 is the only one touching prod.

1. Read endpoint + tests (works against actuals immediately)
2. `NetPositionTab` against actuals only — **shippable here**
3. Write endpoint + tests
4. Provision `HELIO_WRITE_TOKEN` on prod, restart the frontend container
5. `run-net-position.ps1` POSTs after its sidecar write
6. Forecast overlay lights up

## Non-goals

- Net position as a map metric (deferred; diverging scale, worth doing later)
- Cross-border flow visualisation
- Anything V011 — rejected 2026-07-25, see the verdict doc

## Open risks

- Provisioning a write token on prod is a new secret plus a container restart.
- Writing model output into the canonical prod DB is consistent with what
  `forecasts` already holds, but it is the first time the workstation writes to
  prod at all.
- GR/IE staleness is displayed honestly here but not diagnosed.
