import { Request, Response, NextFunction } from 'express';

/**
 * Shared-secret auth middleware for POST write endpoints.
 *
 * Validates `Authorization: Bearer <token>` against the `HELIO_WRITE_TOKEN`
 * env var. If the env var is unset on the server, all writes are rejected
 * with 503 (disabled). If unset on the client side but the server has one,
 * the client gets 401.
 *
 * This is appropriate for LAN-only access. Upgrade to JWT or mTLS if the
 * endpoint ever becomes externally reachable.
 */
export function writeAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.HELIO_WRITE_TOKEN;
  if (!expected) {
    res.status(503).json({
      success: false,
      error: 'Write endpoints disabled: HELIO_WRITE_TOKEN not configured on server.',
      code: 'WRITE_DISABLED',
    });
    return;
  }

  const header = req.header('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || match[1] !== expected) {
    res.status(401).json({
      success: false,
      error: 'Invalid or missing bearer token.',
      code: 'UNAUTHORIZED',
    });
    return;
  }

  next();
}
