import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import fs from 'fs';
import path from 'path';
import routes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

/**
 * The built client, or `null` when this checkout has none.
 *
 * The server decides "am I serving the SPA?" from the presence of a built
 * `index.html` rather than from `NODE_ENV`, which is how a dev checkout and a
 * deployed box tell themselves apart here. Checking the directory as well as
 * the file is redundant — `existsSync` on a path whose parent is missing is
 * already false.
 */
export function resolveClientDist(clientDistPath: string): string | null {
  return fs.existsSync(path.join(clientDistPath, 'index.html')) ? clientDistPath : null;
}

/** `/api` and everything under it — but not `/apiary`. */
function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export interface AppOptions {
  /**
   * Absolute path to the built client. `null` (the default) runs API-only: no
   * static files, no SPA fallback. The error contract is identical either way.
   */
  clientDist?: string | null;
}

/**
 * Build the application. Does not listen — `index.ts` owns the port.
 *
 * The two error handlers are registered **unconditionally**, after the SPA
 * fallback. They used to sit in the `else` of `if (isProduction)`, on the
 * reasoning that "in prod the SPA fallback handles it". It does not:
 * `app.get('*')` catches unmatched *routes*, never a thrown error, and an
 * error handler is the only middleware Express selects by arity. So on any box
 * with a `client/dist` — i.e. every deployed one — every `AppError` reached
 * Express's built-in handler instead, which answers `text/html` and, because
 * `NODE_ENV` is not set to production here, embeds the stack trace with
 * absolute source paths. `GET /api/forecast-comparison/DE/ml-accuracy?
 * forecastType=nonsense` returned a 400 whose body was
 * `<pre>Error: Invalid forecast type...</pre>` over ten frames of repo paths.
 *
 * Scoping the SPA fallback to non-API paths is the other half. Unmatched
 * `/api/*` used to fall into `app.get('*')` and come back as **HTTP 200 with
 * index.html** — a typo'd endpoint that reads as success at the HTTP layer and
 * reaches `unwrap()` as HTML. That is the exact failure `client/src/services/
 * unwrap.ts` already carries a comment about. Now it reaches `notFoundHandler`
 * and answers the documented `{ success: false, error, code: 'NOT_FOUND' }`.
 *
 * `ABL-13`.
 */
export function createApp({ clientDist = null }: AppOptions = {}): Express {
  const app = express();

  app.use(helmet({
    contentSecurityPolicy: clientDist ? {
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

  // Bulk forecast ingest needs a bigger body than the 100kb default: one
  // net-position run is ~456 points with nine quantiles each, roughly 250kb.
  // Scoped to that path and mounted first, so body-parser marks the body as
  // read and the global 100kb limit below still applies to every other route.
  // The route is token-gated and enforces its own row cap.
  app.use('/api/forecasts/net-position', express.json({ limit: '4mb' }));

  app.use(express.json());

  // API Routes
  app.use('/api', routes);

  // Serve the built client, when there is one.
  if (clientDist) {
    // Serve static assets with aggressive caching for hashed files
    app.use(express.static(clientDist, {
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

    // SPA fallback - client-side routes get index.html (no cache). An API path
    // that got this far matched no route, so it belongs to notFoundHandler.
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (isApiPath(req.path)) return next();
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // Error handling. Unconditional and last — see the note above.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
