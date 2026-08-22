import { describe, it, expect } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createChangelogRoutes } from './changelogRoutes.js';
import type { ChangelogEntry } from './changelogEntry.js';
import type { ChangelogReader } from './changelogStore.js';

/**
 * The two representations, over a real socket.
 *
 * Mounted here on a bare Express app rather than through `createPublicApp`,
 * which needs a key store, a meter, a plan gate and a data context — none of
 * which this router touches. The composition is `publicApp.test.ts`'s to assert;
 * this file is about what the two routes answer.
 */

const entries: ChangelogEntry[] = [
  {
    id: 'cl_planned0001',
    type: 'planned',
    publishedAt: '2026-08-22T09:00:00.000Z',
    effectiveAt: '2026-09-21T09:00:00.000Z',
    title: 'A planned change',
    detail: 'What changed and for which datasets.',
    whatWasWrong: null,
    isExample: false,
  },
  {
    id: 'cl_fix00000001',
    type: 'correction',
    publishedAt: '2026-08-25T14:03:00.000Z',
    effectiveAt: '2026-08-25T14:03:00.000Z',
    title: 'A correction',
    detail: 'Values are now served on the right basis.',
    whatWasWrong: 'They were served on the wrong basis for nine days.',
    isExample: false,
  },
];

/**
 * A reader that answers from an array.
 *
 * Written inline rather than as a `memoryChangelogStore.ts` module: this is the
 * only place a fake reader is needed, and a module would be one more thing
 * `publicAppGraph.test.ts` has to assert is unreachable from the serving
 * entrypoints.
 */
function readerOf(list: ChangelogEntry[]): ChangelogReader {
  return { list: () => [...list], close: () => {} };
}

async function serve(reader: ChangelogReader): Promise<{ origin: string; close: () => Promise<void> }> {
  const app = express();
  app.use(createChangelogRoutes({ reader }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind a port');
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function withServer(
  reader: ChangelogReader,
  run: (origin: string) => Promise<void>
): Promise<void> {
  const api = await serve(reader);
  try {
    await run(api.origin);
  } finally {
    await api.close();
  }
}

describe('GET /changelog', () => {
  it('answers HTML, newest first, with no key', async () => {
    await withServer(readerOf(entries), async (origin) => {
      const res = await fetch(`${origin}/changelog`);
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/html; charset=utf-8/);
      expect(html.indexOf('cl_fix00000001')).toBeLessThan(html.indexOf('cl_planned0001'));
    });
  });

  it('is never cached, because a correction has to be visible the moment it is published', async () => {
    // The cache header is part of the publish path here, not a habit: an
    // intermediary holding this page for an hour would defer exactly the notice
    // that has to go up at the same time as the change.
    await withServer(readerOf(entries), async (origin) => {
      for (const p of ['/changelog', '/changelog.json']) {
        const res = await fetch(`${origin}${p}`);
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
    });
  });

  it('shows an entry published after the process started, without a restart', async () => {
    // The claim the whole design is built on, end to end: the route reads the
    // store per request, so publishing is a write and not a deployment.
    const live = [...entries];
    await withServer(readerOf(live), async (origin) => {
      expect(await (await fetch(`${origin}/changelog`)).text()).not.toContain('cl_new000000001');

      live.push({
        ...entries[1],
        id: 'cl_new000000001',
        publishedAt: '2026-08-26T10:00:00.000Z',
        effectiveAt: '2026-08-26T10:00:00.000Z',
      });

      const html = await (await fetch(`${origin}/changelog`)).text();
      expect(html).toContain('cl_new000000001');
      expect(html.indexOf('cl_new000000001')).toBeLessThan(html.indexOf('cl_fix00000001'));
    });
  });

  it('renders an empty change log rather than failing', async () => {
    await withServer(readerOf([]), async (origin) => {
      const res = await fetch(`${origin}/changelog`);

      expect(res.status).toBe(200);
      expect(await res.text()).toContain('No entries have been published yet.');
    });
  });
});

describe('GET /changelog.json', () => {
  it('answers the same entries as data, newest first', async () => {
    await withServer(readerOf(entries), async (origin) => {
      const res = await fetch(`${origin}/changelog.json`);
      const body = (await res.json()) as {
        notice_period_days: number;
        entries: { id: string; type: string; published_at: string; effective_at: string }[];
      };

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(body.notice_period_days).toBe(30);
      expect(body.entries.map((e) => e.id)).toEqual(['cl_fix00000001', 'cl_planned0001']);
      expect(body.entries[1]).toMatchObject({
        type: 'planned',
        published_at: '2026-08-22T09:00:00.000Z',
        effective_at: '2026-09-21T09:00:00.000Z',
      });
    });
  });

  it('gives both instants for every entry, so neither reading is guessed', async () => {
    await withServer(readerOf(entries), async (origin) => {
      const body = (await (await fetch(`${origin}/changelog.json`)).json()) as {
        entries: Record<string, unknown>[];
      };

      for (const entry of body.entries) {
        expect(typeof entry.published_at).toBe('string');
        expect(typeof entry.effective_at).toBe('string');
        expect(entry.published_at).not.toBe(undefined);
      }
      expect(body.entries[1].notice_seconds).toBe(30 * 86_400);
      expect(body.entries[0].notice_seconds).toBe(0);
    });
  });
});

describe('what the router does not answer', () => {
  it('has exactly two routes and adds nothing else', async () => {
    await withServer(readerOf(entries), async (origin) => {
      // `/changelog/` is absent deliberately: Express's non-strict routing makes
      // it the same route, which is the behaviour a subscriber typing the URL
      // wants rather than a second path to keep alive.
      for (const p of ['/', '/changelog/cl_fix00000001', '/changelog.html', '/changelog.txt']) {
        expect((await fetch(`${origin}${p}`)).status).toBe(404);
      }
    });
  });

  it('is read-only: a POST to the change log is not a route', async () => {
    await withServer(readerOf(entries), async (origin) => {
      const res = await fetch(`${origin}/changelog`, { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });
});
