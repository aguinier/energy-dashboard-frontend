import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import routes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Auto-detect production mode by checking if client dist folder exists
const clientDistPath = path.join(__dirname, '../../client/dist');
const isProduction = fs.existsSync(clientDistPath) && fs.existsSync(path.join(clientDistPath, 'index.html'));

// Middleware
app.use(helmet({
  contentSecurityPolicy: isProduction ? {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      // Allow serving over plain HTTP on local network (Tailscale, LAN)
      'upgrade-insecure-requests': null,
    },
  } : false,
}));
app.use(cors({
  origin: true, // Allow all origins for local network access
  credentials: true,
}));
app.use(compression());
app.use(express.json());

// API Routes
app.use('/api', routes);

// In production, serve the built client files
if (isProduction) {
  console.log('🌐 Production mode: serving static files from client/dist');

  // Serve static assets with aggressive caching for hashed files
  app.use(express.static(clientDistPath, {
    maxAge: '1y',
    immutable: true,
    etag: true,
    setHeaders: (res, filePath) => {
      // Hashed assets (JS, CSS with content hash) - cache forever
      if (filePath.match(/\.[a-f0-9]{8}\.(js|css)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
      // HTML files - no cache (always fetch fresh to get new hashes)
      else if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
      // Fonts and images - cache for 1 month
      else if (filePath.match(/\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|webp|ico)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000');
      }
      // Default - cache for 1 day
      else {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    },
  }));

  // SPA fallback - serve index.html for all non-API routes (no cache)
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
} else {
  // Error handling (only in dev - in prod the SPA fallback handles it)
  app.use(notFoundHandler);
  app.use(errorHandler);
}

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
