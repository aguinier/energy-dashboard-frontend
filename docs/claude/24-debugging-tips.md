> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# Debugging Tips

## Debugging Tips

- Check browser DevTools Network tab for API responses
- There is **no** React Query DevTools here — `@tanstack/react-query-devtools`
  is not a dependency of `client/package.json` and no source file mounts it.
  Inspect query state through the Network tab or a temporary log instead.
- The server logs the connected `ENERGY_DB_PATH` at startup
  (`config/database.ts:15`) and again if the write handle opens
  (`config/writeDatabase.ts:29`). It does **not** log queries — there is no
  per-query logging to check
- Acceptance proxies the built local CAT Docker image, not the working-tree
  server, so a working-tree server fix will not show up there. Use the
  `PORT=3002` + local `ENERGY_DB_PATH` procedure in
  [`../WORKFLOWS.md`](../WORKFLOWS.md), **API proxy on CAT**, to exercise it
- **The workstation replica can be hours behind prod even with a fresh mtime.**
  Measured 2026-08-07 07:10 UTC: the replica's newest `energy_load` row was
  `00:15` (≈7h old) while prod's was `05:45` (≈1.4h). Acceptance reads this
  replica, so its data freshness describes CAT, not prod. Anything about
  prod health, freshness, staleness or "is this table current" must be settled
  against prod directly
  (`http://192.168.86.36:3001/api/...`, read-only) — the replica will make a
  healthy pipeline look broken. It is still the right place to measure *shapes*
  (row counts, per-country distributions, table-vs-table comparisons)
