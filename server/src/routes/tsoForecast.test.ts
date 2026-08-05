import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

// Same pattern as forecastComparison.test.ts: the router's services import the
// shared database connection at module load. Every case here is rejected
// during validation, before any query runs.
vi.mock('../config/database.js', () => ({ default: null }));

const { default: router } = await import('./tsoForecast.js');
const { errorHandler } = await import('../middleware/errorHandler.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use('/api/tso-forecast', router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}/api/tso-forecast`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function get(path: string) {
  const res = await fetch(`${base}/${path}`);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('TSO accuracy routes — model parameter', () => {
  it('rejects an ml model on a tso accuracy endpoint', async () => {
    // catboost is registered for load, but this route measures the TSO's own
    // forecast. Ignoring the parameter would answer a different question.
    const { status, body } = await get('accuracy/load/DE?model=catboost');
    expect(status).toBe(400);
    expect(body.code).toBe('WRONG_MODEL_SOURCE');
  });

  it('rejects an unregistered model', async () => {
    const { status, body } = await get('accuracy/load/DE?model=tso-d99');
    expect(status).toBe(400);
    expect(body.code).toBe('UNREGISTERED_MODEL');
  });

  it('rejects a model/forecastType conflict rather than silently picking one', async () => {
    // tso-d7 IS week_ahead. Honouring either side quietly would label the
    // response with a horizon the caller did not ask for.
    const { status, body } = await get('accuracy/load/DE?model=tso-d7&forecastType=day_ahead');
    expect(status).toBe(400);
    expect(body.code).toBe('MODEL_HORIZON_CONFLICT');
  });

  it('accepts a model that agrees with an explicit forecastType', async () => {
    // Not a conflict — both name week_ahead. Gets past validation and fails
    // later on the mocked-out database, which is what proves it was accepted.
    const { body } = await get('accuracy/load/DE?model=tso-d7&forecastType=week_ahead');
    expect(body.code).not.toBe('MODEL_HORIZON_CONFLICT');
  });

  it('rejects week-ahead for a generation type that registers day-ahead only', async () => {
    // There is no week-ahead solar forecast to measure. Answering with D+1
    // would be a fabricated horizon.
    const { status, body } = await get('accuracy/generation/DE?type=solar&model=tso-d7');
    expect(status).toBe(400);
    expect(body.code).toBe('UNREGISTERED_MODEL');
  });

  it('validates the generation type before the model', async () => {
    const { status, body } = await get('accuracy/generation/DE?model=tso-d1');
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_GENERATION_TYPE');
  });
});
