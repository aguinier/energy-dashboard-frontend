import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

// The router pulls in services that import the shared database connection,
// which opens a real SQLite file at import time (same pattern as
// mlForecastService.test.ts). Every case here is rejected during validation,
// before any query runs, so the handle only needs to not exist.
vi.mock('../config/database.js', () => ({ default: null }));

const { default: router } = await import('./forecastComparison.js');
const { errorHandler } = await import('../middleware/errorHandler.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use('/api/forecast-comparison', router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}/api/forecast-comparison`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const WINDOW = 'start=2026-07-25T00:00:00Z&end=2026-08-01T00:00:00Z';

async function get(path: string) {
  const res = await fetch(`${base}/${path}`);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('GET /:countryCode/ml-accuracy — model parameter', () => {
  it('rejects an unregistered model rather than querying for it', async () => {
    // An unregistered id would return zero rows, which is indistinguishable
    // from a registered model that has no coverage here. Reject instead.
    const { status, body } = await get(`DE/ml-accuracy?${WINDOW}&forecastType=load&model=bogus`);
    expect(status).toBe(400);
    expect(body.code).toBe('UNREGISTERED_MODEL');
    expect(body.success).toBe(false);
  });

  it('rejects a model that lost its evaluation and was never registered', async () => {
    const { status, body } = await get(
      `DE/ml-accuracy?${WINDOW}&forecastType=load&model=chronos-2-V011`
    );
    expect(status).toBe(400);
    expect(body.code).toBe('UNREGISTERED_MODEL');
  });

  it('rejects a tso model on the ml accuracy endpoint', async () => {
    // tso-d1 is registered for load, but this endpoint measures ml forecasts.
    // Silently ignoring it would answer a different question than was asked.
    const { status, body } = await get(`DE/ml-accuracy?${WINDOW}&forecastType=load&model=tso-d1`);
    expect(status).toBe(400);
    expect(body.code).toBe('WRONG_MODEL_SOURCE');
  });

  it('rejects a model not registered for the requested forecast type', async () => {
    // catboost serves load, but wind_offshore registers xgboost + tso-d1 only.
    // The registry is per-type, so a valid id elsewhere is not valid here.
    const { status, body } = await get(
      `DE/ml-accuracy?${WINDOW}&forecastType=wind_offshore&model=catboost`
    );
    expect(status).toBe(400);
    expect(body.code).toBe('UNREGISTERED_MODEL');
  });

  it('names the servable alternatives so a 400 is actionable', async () => {
    const { body } = await get(`DE/ml-accuracy?${WINDOW}&forecastType=load&model=bogus`);
    expect(String(body.error)).toContain('catboost');
  });

  it('still rejects an invalid forecast type ahead of the model check', async () => {
    const { status, body } = await get(`DE/ml-accuracy?${WINDOW}&forecastType=nonsense&model=catboost`);
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_FORECAST_TYPE');
  });
});
