import path from 'path';
import { fileURLToPath } from 'url';
import { createApp, resolveClientDist } from './app.js';
import { startForecastVintageArchiveScheduler } from './services/forecastVintageArchiveScheduler.js';
import { startCoreNetPositionScheduler } from './services/coreNetPositionScheduler.js';
import { startOpsSnapshotScheduler } from './services/opsSnapshotScheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;

// Auto-detect production mode by checking if client dist folder exists
const clientDist = resolveClientDist(path.join(__dirname, '../../client/dist'));
if (clientDist) {
  console.log('🌐 Production mode: serving static files from client/dist');
}

const app = createApp({ clientDist });

// Start server (bind to 0.0.0.0 for network access)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
⚡ Energy Dashboard API Server
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 Server running on http://localhost:${PORT}
📊 API base URL: http://localhost:${PORT}/api
💚 Health check: http://localhost:${PORT}/api/health

Available endpoints:
  GET /api/countries        - List all countries
  GET /api/load            - Electricity load data
  GET /api/prices          - Energy price data
  GET /api/renewables      - Renewable energy data
  GET /api/dashboard/*     - Dashboard aggregations
  GET /api/forecasts/*     - Forecast predictions
`);
});

// ABL-184: begins capturing forecast vintages once this process is deployed
// and running with a write connection available. See
// services/forecastVintageArchiveScheduler.ts for why it runs in a worker
// thread on a timer, gated the same way getWriteDb() is.
startForecastVintageArchiveScheduler();

// ABL-230: begins capturing JAO's Core CCR net position once BOTH
// JAO_CORE_NET_POSITION_ENABLED and HELIO_WRITE_TOKEN are set. Neither is set
// by this change — see services/coreNetPositionScheduler.ts for why this is a
// dedicated variable rather than a reuse of HELIO_WRITE_TOKEN alone, and why
// that means deploying this code changes nothing in prod until a separate,
// coordinated step turns it on.
startCoreNetPositionScheduler();

// ABL-288: records a snapshot of /api/ops/status/combined every
// OPS_SNAPSHOT_INTERVAL_MINUTES so /ops-status can show a trend and a disk
// headroom projection. Unlike the two schedulers above it writes only its own
// JSONL file — never the shared database — so it is on by default; see
// services/opsSnapshotStore.ts. A capture that fails is logged and dropped.
startOpsSnapshotScheduler();

export default app;
