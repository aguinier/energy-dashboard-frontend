import { describe, it, expect } from 'vitest';
import { classifyRequest, type RequestLane } from './classifyRequest.js';

/** A realistic desktop Chrome UA — the thing every "is this a person" test needs. */
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function lane(path: string, userAgent: string | undefined = BROWSER, method = 'GET'): RequestLane {
  return classifyRequest({ method, path, userAgent });
}

describe('classifyRequest — the monitoring lane', () => {
  it('counts the health endpoint as automated even from a real browser UA', () => {
    // The docker HEALTHCHECK and ABL-172's acceptance probe both live here, and
    // a human opening /api/health in a tab is still not a dashboard visit.
    expect(lane('/api/health')).toBe('automated');
  });

  it('counts every /api/ops path as automated', () => {
    // Both the peer fetch (`peerOpsStatus.ts` → the peer's /api/ops/status) and
    // the status page's own 30s refetch of /combined. Left in the `api` lane,
    // the status page would be the single largest source of "app traffic" on a
    // box nobody visits — the exact number this issue exists to not report.
    expect(lane('/api/ops/status')).toBe('automated');
    expect(lane('/api/ops/status/combined')).toBe('automated');
    expect(lane('/api/ops')).toBe('automated');
  });

  it('does not swallow a sibling path that merely starts with the same letters', () => {
    expect(lane('/api/operations')).toBe('api');
    expect(lane('/api/healthcheck-summary')).toBe('api');
  });
});

describe('classifyRequest — automated user agents', () => {
  const automated = [
    'curl/8.5.0',
    'Wget/1.21.4',
    'python-requests/2.32.3',
    'Go-http-client/2.0',
    'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
    'axios/1.7.2',
    'okhttp/4.12.0',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; YandexBot/3.0)',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'Mozilla/5.0 (compatible; Yahoo! Slurp)',
    'Pingdom.com_bot_version_1.4',
    'Prometheus/2.53.0',
    'Better Uptime Bot',
    'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/131.0.0.0',
  ];

  it.each(automated)('classifies %s as automated', (ua) => {
    expect(lane('/', ua)).toBe('automated');
  });

  it('treats a missing or blank user agent as automated', () => {
    // Every mainstream browser sends a UA. An absent one is a socket probe or a
    // script, and counting it as a visitor inflates the headline figure.
    // Called directly rather than through `lane`, whose default UA would
    // silently replace the `undefined` this case is entirely about.
    expect(classifyRequest({ method: 'GET', path: '/', userAgent: undefined })).toBe('automated');
    expect(lane('/', '')).toBe('automated');
    expect(lane('/', '   ')).toBe('automated');
  });

  it('does not mistake a real browser for a bot', () => {
    const browsers = [
      BROWSER,
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    ];
    for (const ua of browsers) expect(lane('/', ua)).toBe('page');
  });
});

describe('classifyRequest — writes', () => {
  it('classifies every non-read method as automated', () => {
    // The only writes this server accepts are token-gated ingest: heliocast's
    // weather snapshot and the workstation's net-position run. No visitor POSTs.
    expect(lane('/api/weather/snapshot', BROWSER, 'POST')).toBe('automated');
    expect(lane('/api/forecasts/net-position', BROWSER, 'POST')).toBe('automated');
    expect(lane('/api/countries', BROWSER, 'DELETE')).toBe('automated');
  });

  it('still counts HEAD as a read', () => {
    expect(lane('/', BROWSER, 'HEAD')).toBe('page');
    expect(lane('/', BROWSER, 'head')).toBe('page');
  });
});

describe('classifyRequest — pages, API and assets', () => {
  it('counts an SPA document load as a page', () => {
    // index.html is served no-store (`app.ts`), so a visit and a hard refresh
    // each produce exactly one of these. It is the closest measurable proxy for
    // "somebody opened the dashboard".
    expect(lane('/')).toBe('page');
    expect(lane('/index.html')).toBe('page');
    expect(lane('/country/DE')).toBe('page');
    expect(lane('/ops-status')).toBe('page');
    expect(lane('/comparison')).toBe('page');
  });

  it('counts a data call as api', () => {
    expect(lane('/api/countries')).toBe('api');
    expect(lane('/api/dashboard/overview')).toBe('api');
    expect(lane('/api/data-freshness/BE')).toBe('api');
  });

  it('counts static files as assets, not as page loads', () => {
    // One page load fans out into a dozen of these. Folding them into `page`
    // would multiply the headline visitor figure by a cache-dependent factor.
    expect(lane('/assets/index.1a2b3c4d.js')).toBe('asset');
    expect(lane('/assets/index.9f8e7d6c.css')).toBe('asset');
    expect(lane('/favicon.ico')).toBe('asset');
    expect(lane('/fonts/inter-latin.woff2')).toBe('asset');
    expect(lane('/able-logo.svg')).toBe('asset');
  });

  it('does not read a dotted client-side route segment as a file extension', () => {
    // The extension has to be short and alphanumeric, and a long trailing
    // segment after a dot is a route, not a file.
    expect(lane('/country/DE.something-long-here')).toBe('page');
  });

  it('classifies the four lanes exhaustively — every request lands in exactly one', () => {
    const samples: Array<[string, string | undefined, string]> = [
      ['/', BROWSER, 'GET'],
      ['/api/countries', BROWSER, 'GET'],
      ['/assets/x.1a2b3c4d.js', BROWSER, 'GET'],
      ['/api/health', undefined, 'GET'],
    ];
    const lanes = samples.map(([p, ua, m]) => classifyRequest({ path: p, userAgent: ua, method: m }));
    expect(lanes).toEqual(['page', 'api', 'asset', 'automated']);
  });
});
