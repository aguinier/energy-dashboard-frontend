# Energy Dashboard Frontend

React + TypeScript web dashboard for visualizing European energy market data. Interactive map, time-series charts for load/price/renewables, TSO forecast overlays, and forecast accuracy analytics.

Migrated from the [energy-dashboard](https://github.com/aguinier/energy-dashboard) monorepo.

## Quick Start

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- API Server: http://localhost:3001

## Docker

```bash
cd docker
# Set DB_DIR in .env (directory containing energy_dashboard.db)
docker compose up -d --build
```

## Production deployment

The production dashboard runs on **QuietlyConfident** at
`http://192.168.86.36:3001`. Its checkout is
`/home/clavain/energy-dashboard/repos/energy-dashboard-frontend`; Docker Compose
there builds and runs the `energy-dashboard-frontend` container.

After a reviewed change has been pushed to GitHub, deploy it from the production
host:

```bash
ssh clavain@192.168.86.36
cd /home/clavain/energy-dashboard/repos/energy-dashboard-frontend
git pull
cd docker
docker compose build
docker compose up -d --force-recreate
```

Do not make code commits on the production host. Production is a deploy target,
not a development checkout. The server and client are built into the same image,
so a rebuild deploys both together. The dashboard reads the canonical database
mounted at `/data/energy_dashboard.db`; do not change database configuration as
part of an ordinary dashboard deploy.

For the complete production and acceptance topology, see the workstation-level
[`WORKFLOWS.md`](../WORKFLOWS.md).

## Documentation

See [CLAUDE.md](CLAUDE.md) for detailed frontend documentation including component architecture, API endpoints, and state management.
