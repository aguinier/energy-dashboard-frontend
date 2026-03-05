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

## Documentation

See [CLAUDE.md](CLAUDE.md) for detailed frontend documentation including component architecture, API endpoints, and state management.
