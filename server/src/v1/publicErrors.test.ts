import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { PublicApiError, publicErrorHandler, publicNotFoundHandler } from './publicErrors.js';

/** Minimal res double capturing the status/body the handler chose. */
function fakeRes(headersSent = false) {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    headersSent,
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { res: res as unknown as Response, captured };
}

function handle(err: unknown, headersSent = false) {
  const { res, captured } = fakeRes(headersSent);
  publicErrorHandler(err, {} as Request, res, (() => {}) as NextFunction);
  return captured;
}

vi.spyOn(console, 'error').mockImplementation(() => {});

describe('publicErrorHandler', () => {
  it('shows a PublicApiError message, because someone wrote it for a customer', () => {
    const out = handle(
      new PublicApiError(400, 'invalid_zone', 'Unknown zone. See /v1/catalog/zones for the list.')
    );

    expect(out.status).toBe(400);
    expect(out.body).toEqual({
      error: { code: 'invalid_zone', message: 'Unknown zone. See /v1/catalog/zones for the list.' },
    });
  });

  it('masks a better-sqlite3 failure, message and all', () => {
    // The shape better-sqlite3 actually throws: SQLITE_ERROR on `code`, the
    // schema detail in the message. The internal handler already masks this
    // one; the public handler masks it because it masks everything.
    const err = Object.assign(new Error('no such column: hydro_mw'), { code: 'SQLITE_ERROR' });
    const out = handle(err);

    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: { code: 'internal_error', message: 'An unexpected error occurred.' } });
    expect(JSON.stringify(out.body)).not.toContain('hydro_mw');
  });

  it('masks an internal AppError message while keeping its status', () => {
    // `middleware/errorHandler.ts`'s AppError, duck-typed. A 4xx is a claim
    // about the request and is worth preserving; the message is not, because
    // the internal ones echo caller input (`Country not found: ${code}`,
    // `routes/countries.ts:34`) and enumerate the model registry
    // (`config/forecastModels.ts:186-189`).
    const out = handle(Object.assign(new Error('Country not found: <script>x</script>'), { statusCode: 400 }));

    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: { code: 'bad_request', message: 'The request could not be understood.' } });
    expect(JSON.stringify(out.body)).not.toContain('script');
  });

  it('masks a raw exception whose message carries a filesystem path', () => {
    const err = new Error("ENOENT: no such file or directory, open 'C:\\data\\energy_dashboard.db'");
    const out = handle(err);

    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toContain('energy_dashboard.db');
    expect(JSON.stringify(out.body)).not.toContain('C:\\');
  });

  it('masks a host name', () => {
    // What `services/peerOpsStatus.ts` puts on the wire today, as a 200.
    const out = handle(new Error('fetch failed: connect ECONNREFUSED 192.168.86.36:3001'));

    expect(JSON.stringify(out.body)).not.toContain('192.168.86.36');
  });

  it('honours a body-parser status without trusting its message', () => {
    // http-errors sets both `status` and `statusCode`; the message names the
    // byte offset and part of the body.
    const err = Object.assign(new SyntaxError('Unexpected token } in JSON at position 42'), {
      status: 400,
      statusCode: 400,
    });
    const out = handle(err);

    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).not.toContain('position 42');
  });

  it('does not let a 5xx status pick its own body', () => {
    // A thrown error claiming 503 still collapses to a plain 500: the
    // distinctions between server-side failures are internal.
    const out = handle(Object.assign(new Error('upstream replica lagging'), { statusCode: 503 }));

    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: { code: 'internal_error', message: 'An unexpected error occurred.' } });
  });

  it('ignores a nonsense status rather than putting it on the wire', () => {
    for (const statusCode of [0, -1, 200, 999, 4.5, '400', null]) {
      expect(handle(Object.assign(new Error('x'), { statusCode })).status).toBe(500);
    }
  });

  it('survives a non-Error being thrown', () => {
    for (const thrown of ['a string', 42, null, undefined, { message: 'not an Error' }]) {
      const out = handle(thrown);
      expect(out.status).toBe(500);
      expect(out.body).toEqual({ error: { code: 'internal_error', message: 'An unexpected error occurred.' } });
    }
  });

  it('writes nothing once headers are out', () => {
    // Streaming a large collection then failing halfway: there is no status
    // left to set, and trying would throw a second error over the first.
    const out = handle(new Error('failed mid-stream'), true);

    expect(out.status).toBeUndefined();
    expect(out.body).toBeUndefined();
  });

  it('gives every 4xx a code and a message, none of which interpolate anything', () => {
    for (const status of [400, 401, 403, 404, 405, 413, 429, 451]) {
      const out = handle(Object.assign(new Error('detail'), { statusCode: status }));
      const body = out.body as { error: { code: string; message: string } };

      expect(typeof body.error.code).toBe('string');
      expect(body.error.code).not.toBe('');
      expect(body.error.message).not.toContain('detail');
    }
  });
});

describe('publicNotFoundHandler', () => {
  it('answers the typed 404 envelope, with no echo of the path', () => {
    const { res, captured } = fakeRes();
    publicNotFoundHandler({ path: '/api/ops/status' } as Request, res);

    expect(captured.status).toBe(404);
    expect(captured.body).toEqual({ error: { code: 'not_found', message: 'No such resource.' } });
    expect(JSON.stringify(captured.body)).not.toContain('ops');
  });
});
