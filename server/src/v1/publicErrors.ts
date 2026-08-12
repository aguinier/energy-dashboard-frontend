import type { Request, Response, NextFunction } from 'express';

/**
 * The public error contract: a typed body, and nothing that came from inside.
 *
 * `middleware/errorHandler.ts` already masks `SQLITE_*` failures, and that mask
 * is the right idea — but it is an allowlist of one. Everything else reaches
 * the wire with `err.message` intact, which is correct for the internal app
 * (a developer reading a LAN dashboard wants the message) and wrong for a paid
 * public surface, where the message is written by whatever threw.
 *
 * So this handler inverts the default. A message reaches a public caller
 * **only** when it was constructed as a `PublicApiError` — i.e. when somebody
 * wrote it for a customer to read. Every other error, whatever its type, is
 * answered with a constant string chosen by status. There is no branch that
 * formats an arbitrary `err.message`, so there is no path by which a file path,
 * a column name, a hostname or a commit SHA can be echoed out. That is a
 * property of the code's shape rather than of a filter someone maintains.
 *
 * The envelope is `{ error: { code, message } }` — the shape ABL-293 §2a
 * specifies for `/v1`, and deliberately not the internal
 * `{ success: false, error, code }`: a public API signals failure with the HTTP
 * status, not with a flag inside a 200.
 */

/** An error whose `message` is safe to show a customer, because it was written for one. */
export class PublicApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PublicApiError';
    this.status = status;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export interface PublicErrorBody {
  error: { code: string; message: string };
}

/**
 * Generic bodies, keyed by status.
 *
 * Every one is a constant. Nothing here interpolates a value, and that is the
 * invariant `publicErrors.test.ts` pins — a future edit that adds
 * `` `Unknown field ${name}` `` to this table reopens the reflected-input hole
 * ABL-293 §1.2(e) describes.
 */
const GENERIC: Record<number, { code: string; message: string }> = {
  400: { code: 'bad_request', message: 'The request could not be understood.' },
  401: { code: 'unauthorized', message: 'A valid API key is required.' },
  403: { code: 'forbidden', message: 'This key is not permitted to make that request.' },
  404: { code: 'not_found', message: 'No such resource.' },
  405: { code: 'method_not_allowed', message: 'That method is not supported on this resource.' },
  413: { code: 'payload_too_large', message: 'The request body is too large.' },
  429: { code: 'rate_limit_exceeded', message: 'Rate limit exceeded.' },
};

const SERVER_FAULT = { code: 'internal_error', message: 'An unexpected error occurred.' };

/**
 * The status an error asks for, when the request is what was wrong.
 *
 * Read structurally rather than by `instanceof AppError`, on purpose. The
 * public app does not import the internal error module — it should stay
 * possible to delete every route in `routes/` without touching this file — and
 * a duck-typed read states the actual contract: "a number in the 4xx range on
 * `status`/`statusCode` is a claim about the *request*, and nothing else about
 * the error is trusted." `express.json`'s body-parser errors and `http-errors`
 * both set these fields, so callers' malformed input keeps its status without a
 * special case.
 *
 * 5xx is deliberately not honoured here: every server-side failure collapses to
 * a plain 500, because the distinctions between them are internal.
 */
function requestFaultStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  for (const candidate of [status, statusCode]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 499) {
      return candidate;
    }
  }
  return null;
}

/** The body a given status answers with, falling back to a bare 4xx/500. */
function genericFor(status: number): { code: string; message: string } {
  if (GENERIC[status]) return GENERIC[status];
  return status >= 400 && status <= 499
    ? { code: 'bad_request', message: 'The request could not be understood.' }
    : SERVER_FAULT;
}

export function publicNotFoundHandler(_req: Request, res: Response): void {
  const body: PublicErrorBody = { error: GENERIC[404] };
  res.status(404).json(body);
}

export function publicErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Server-side logging keeps the detail: it is the wire that is scrubbed, not
  // the operator's view. `console.error` matches what `errorHandler` already
  // does, so a public process's output reads the same way in a terminal.
  console.error('Public API error:', err instanceof Error ? err.stack ?? err.message : err);

  // Express falls back to its own HTML handler once headers are out; there is
  // nothing left to write, so hand it back rather than throwing a second error.
  if (res.headersSent) return;

  if (err instanceof PublicApiError) {
    const body: PublicErrorBody = { error: { code: err.code, message: err.message } };
    res.status(err.status).json(body);
    return;
  }

  const status = requestFaultStatus(err) ?? 500;
  const body: PublicErrorBody = { error: genericFor(status) };
  res.status(status).json(body);
}
