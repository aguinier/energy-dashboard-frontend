> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# Database Connection

## Database Connection

The server reads `ENERGY_DB_PATH` and opens that SQLite file **readonly**:

```typescript
// server/src/config/database.ts
const dbPath = process.env.ENERGY_DB_PATH || '/data/energy_dashboard.db';
const db = new Database(dbPath, { readonly: true });
```

For local dev, copy `server/.env.example` to `server/.env` and set
`ENERGY_DB_PATH` to your machine's replica (`tsx watch --env-file-if-exists=.env`
loads it automatically). In Docker/production `ENERGY_DB_PATH` comes from the
container instead, and the built bundle (`npm start`) does not read `server/.env`.

**`client/.env.local`'s `API_PROXY_TARGET`** controls where the Vite dev
server proxies `/api` (`client/vite.config.ts`) — copy `client/.env.example`
to override it. Unset, it proxies to `http://localhost:3001` (your local
server). On CAT, the acceptance target is the local dashboard Docker
container, which reads the CAT replica database. It serves a built image, so
working-tree server changes are not visible through the ordinary acceptance
proxy. See [`../WORKFLOWS.md`](../WORKFLOWS.md), **API proxy on CAT**, for the
authoritative target and the separate local-server procedure used to exercise
server changes; keep the environment-specific address there rather than
duplicating it here.
