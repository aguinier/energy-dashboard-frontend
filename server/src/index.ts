import path from 'path';
import { fileURLToPath } from 'url';
import { createApp, resolveClientDist } from './app.js';
import { startForecastVintageArchiveScheduler } from './services/forecastVintageArchiveScheduler.js';
import { startCoreNetPositionScheduler } from './services/coreNetPositionScheduler.js';
import { startOpsAlertScheduler } from './services/opsAlertScheduler.js';
import { startOpsSnapshotScheduler } from './services/opsSnapshotScheduler.js';
import { startBreachWatchScheduler } from './services/breachWatchScheduler.js';

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

// ABL-287: the scheduled check that turns the ops status page into a
// monitoring tool — reads both lanes' KPIs every 5 minutes and logs a line
// when one crosses into warn/error or recovers. On by default (the only
// channel is logging, so there is no external side effect to opt into);
// OPS_ALERTS_ENABLED=false turns it off. See services/opsAlertScheduler.ts.
//
// Independent of the snapshot capture above: that store holds the *readings*,
// this one holds only what was last announced. Neither reads the other — see
// lib/opsAlertStateStore.ts for why re-deriving alert state from stored
// readings would let a threshold change suppress its own alert.
startOpsAlertScheduler();

// ABL-578: reads the /v1 auth-failure tables ABL-530 fills and opens a
// priority:high INCIDENT issue for the CEO when an ABL-524 Tier 1 signal trips.
// Until this existed, a credential attack was fully visible in storage and seen
// by nobody.
//
// It runs *here*, in the private process, rather than in the /v1 process that
// owns those tables — the reasoning is at the top of
// services/breachWatch/authFailureReader.ts, and it comes down to keeping a
// Paperclip API credential out of the process ABL-291 may expose. It opens the
// key store readonly and only when API_KEYS_DB_PATH is set; in a deployment not
// running /v1 (the common case, including every dev checkout) it reports "nothing
// to watch" once and does nothing further.
startBreachWatchScheduler();

export default app;
