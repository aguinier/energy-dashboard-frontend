import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { classifyRequest } from '../lib/classifyRequest.js';
import { visitorCounters, type VisitorCounterStore } from '../services/visitorCounters.js';

/**
 * Counts every request into a lane for `/ops-status` (ABL-289).
 *
 * Mounted in `app.ts` ahead of the API router and the static mount, so it sees
 * SPA document loads and assets as well as `/api/*`. It never reads or writes
 * the body, never touches the database, and answers nothing itself.
 *
 * The whole handler is wrapped in a try/catch that swallows. A visitor counter
 * is the least important thing this server does; it must not be able to 500 a
 * request, and there is no failure mode here worth failing a page load over.
 * The cost of swallowing is an undercount, which `countingSince` and the
 * page's own footnote already frame as approximate.
 */
export function requestCounter(store: VisitorCounterStore = visitorCounters): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const userAgent = req.get('user-agent') ?? undefined;
      const lane = classifyRequest({ method: req.method, path: req.path, userAgent });
      store.record(lane, store.clientKeyFor(req.ip, userAgent), new Date());
    } catch {
      // Deliberately ignored — see above.
    }
    next();
  };
}
