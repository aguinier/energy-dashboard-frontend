import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { errorHandler, AppError } from './errorHandler.js';

/** Minimal res double capturing the status/body the handler chose. */
function fakeRes() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
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

function handle(err: Error) {
  const { res, captured } = fakeRes();
  errorHandler(err, {} as Request, res, (() => {}) as NextFunction);
  return captured;
}

// The handler logs every error; silence it so a passing run stays readable.
vi.spyOn(console, 'error').mockImplementation(() => {});

describe('errorHandler', () => {
  it('passes an AppError through with its own status and code', () => {
    const out = handle(new AppError('Country code is required', 400, 'MISSING_COUNTRY'));
    expect(out.status).toBe(400);
    expect(out.body).toEqual({
      success: false,
      error: 'Country code is required',
      code: 'MISSING_COUNTRY',
    });
  });

  it('classifies a better-sqlite3 failure by err.code, not by the message', () => {
    // This is the shape better-sqlite3 actually throws: SQLITE_ERROR lives on
    // `code`, and the message names the SQL problem. The handler used to test
    // `err.message.includes('SQLITE')`, which never matched — so every real SQL
    // failure was reported as a generic INTERNAL_ERROR. `no such column:
    // hydro_mw` was the live example (forecastService's actual-column mapping).
    const err = Object.assign(new Error('no such column: hydro_mw'), { code: 'SQLITE_ERROR' });
    const out = handle(err);

    expect(out.status).toBe(500);
    expect(out.body).toEqual({
      success: false,
      error: 'Database error occurred',
      code: 'DATABASE_ERROR',
    });
  });

  it('covers the other SQLITE_* codes, not just SQLITE_ERROR', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_READONLY', 'SQLITE_CONSTRAINT_UNIQUE']) {
      const err = Object.assign(new Error('whatever'), { code });
      expect((handle(err).body as { code: string }).code).toBe('DATABASE_ERROR');
    }
  });

  it('does not leak the SQL detail to the client', () => {
    const err = Object.assign(new Error('no such column: hydro_mw'), { code: 'SQLITE_ERROR' });
    expect(JSON.stringify(handle(err).body)).not.toContain('hydro_mw');
  });

  it('still reports an unrecognised error as INTERNAL_ERROR', () => {
    const out = handle(new Error('kaboom'));
    expect(out.status).toBe(500);
    expect(out.body).toEqual({
      success: false,
      error: 'An unexpected error occurred',
      code: 'INTERNAL_ERROR',
    });
  });

  it('does not mistake a non-string code for a sqlite code', () => {
    // Some libraries put a numeric errno on `code`; `.startsWith` would throw.
    const err = Object.assign(new Error('boom'), { code: 14 });
    expect((handle(err).body as { code: string }).code).toBe('INTERNAL_ERROR');
  });
});
