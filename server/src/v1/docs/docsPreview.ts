import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINKED_ELSEWHERE, loadDocsSite, type DocsResource } from './docsSite.js';

/**
 * Read the documentation site on this machine.
 *
 * ```
 * npm run docs:preview -w server
 * ```
 *
 * ## This is the only thing that serves the site, and it is why
 *
 * ABL-522 Constraint 3 and the Board's 2026-09-03 build-and-hold ruling: the
 * site is built, previewed and reviewed now, and deployed to a public URL only
 * after the ABL-349 gate lifts, as a separate Board-gated act. This process is
 * how "previewed and reviewed" happens without "deployed" happening by accident.
 *
 * **The bind address is a constant, not configuration.** `publicIndex.ts` has
 * `PUBLIC_BIND_HOST` so its deployment address is a setting rather than a code
 * change; this deliberately has no equivalent, because the equivalent would be
 * the one-environment-variable path to publishing a site nobody has approved
 * publishing. There is no spelling of "serve this to the network" here. Making
 * one is a diff.
 *
 * The port is configurable — `DOCS_PREVIEW_PORT` — because a busy port is an
 * ordinary annoyance and changing it exposes nothing.
 *
 * ## It sends the public app's CSP
 *
 * A preview that is more permissive than the deployment is a preview that
 * cannot detect the one class of bug this site's whole shape exists to prevent.
 * `default-src 'none'` is sent here so that a subresource somebody adds is
 * refused by the browser **while they are looking at the page**, rather than
 * after it goes live. It is the same header `createPublicApp` sends, restated
 * rather than imported: importing the public app to preview a site the public
 * app must not know about would defeat the composition lock that holds
 * Constraint 3.
 */

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3003;

/**
 * The headers every response carries.
 *
 * `no-store` for the same reason `/changelog` sends it: a preview whose page a
 * browser caches is a preview that shows the previous build, which turns a
 * rendering fix into ten minutes of confusion.
 */
export const PREVIEW_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
};

/**
 * The body for a path this site does not serve.
 *
 * It names `/changelog` on purpose. A reviewer following the site's own
 * navigation reaches it and gets a 404 from this process, and the honest
 * explanation — that the change log is served by the public process and this
 * site links it rather than forking it — is the thing they need at that moment.
 * Text, not HTML, so a 404 body can never be mistaken for a page of the site.
 */
export function notFoundBody(requestPath: string): string {
  const linked = LINKED_ELSEWHERE.includes(requestPath);
  return linked
    ? `${requestPath} is not served by the documentation site.\n\n` +
        'It is served by the public API process (ABL-532), on the same origin the site will ' +
        'eventually be mounted on. This site links to it rather than rendering it, so that ' +
        'publishing an entry stays a sub-second CLI call instead of a site rebuild.\n\n' +
        'To read it locally, run `npm run dev:public -w server` and open /changelog there.\n'
    : `${requestPath} is not a page of this site.\n`;
}

export function createPreviewHandler(
  site: ReadonlyMap<string, DocsResource>
): http.RequestListener {
  return (req, res) => {
    // Path only: a query string is not part of any path this site serves, and
    // reading one would be the first step towards a page that varies by input.
    const requestPath = (req.url ?? '/').split('?')[0].split('#')[0];
    const resource = site.get(requestPath);

    if (resource === undefined) {
      res.writeHead(404, { ...PREVIEW_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(notFoundBody(requestPath));
      return;
    }

    res.writeHead(200, { ...PREVIEW_HEADERS, 'Content-Type': resource.contentType });
    res.end(req.method === 'HEAD' ? undefined : resource.body);
  };
}

export function startPreview(port: number = Number(process.env.DOCS_PREVIEW_PORT) || DEFAULT_PORT) {
  // Built before `listen`, so a document that may not be published fails the
  // command rather than being served to whoever opens the page first.
  const site = loadDocsSite();
  const server = http.createServer(createPreviewHandler(site));

  server.listen(port, HOST, () => {
    console.log(`Documentation site preview — local only, bound to ${HOST}`);
    for (const servedPath of site.keys()) console.log(`  http://${HOST}:${port}${servedPath}`);
    console.log(
      '\nNot published. ABL-349 is open, and deploying this to a public URL is a separate ' +
        'Board-gated act (ABL-522 Constraint 3).'
    );
  });

  return server;
}

// `tsx src/v1/docs/docsPreview.ts` runs this; importing the module does not.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startPreview();
}
