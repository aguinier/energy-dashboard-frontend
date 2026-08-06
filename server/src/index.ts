import path from 'path';
import { fileURLToPath } from 'url';
import { createApp, resolveClientDist } from './app.js';

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

export default app;
