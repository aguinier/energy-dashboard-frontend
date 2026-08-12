import { createPublicApp } from './publicApp.js';
import { openApiKeyDirectory } from './keys/sqliteApiKeyStore.js';

/**
 * Entrypoint for the public process.
 *
 * A second process, not a second mount on the first. `index.ts` keeps port 3001
 * with the dashboard, the ingest `POST`s, `/api/ops/*` and `/api/health`
 * untouched; this one serves `/v1` and nothing else. Two processes is what lets
 * the private surface stay exactly as it is — the reason ABL-293 §2f prices
 * this isolation at 2–3 days now against 3–4× that as a retrofit.
 *
 * It also starts **no schedulers**. `index.ts:41-49` starts the forecast
 * vintage archive and the JAO capture, both of which take a write connection.
 * Their absence here is the runtime half of "no write capability": there is no
 * timer in this process that could open one.
 *
 * ## Binding
 *
 * Defaults to `127.0.0.1`. `PUBLIC_BIND_HOST` exists so the bind address is
 * build-time configuration rather than a code change — but choosing a value
 * other than loopback is a network-exposure decision, and per ABL-291 and this
 * agent's charter that decision needs its own Board-approved issue. Nothing in
 * this repository sets it, and ABL-304 neither deploys this process nor starts
 * it anywhere.
 *
 * The private app binds `0.0.0.0` (`index.ts:19`) and keeps doing so; that is
 * the existing LAN dashboard and is out of scope here.
 *
 * ## The key store
 *
 * This is the one place a concrete key store is chosen. `openApiKeyDirectory`
 * opens `API_KEYS_DB_PATH` **readonly**, so the serving process cannot write to
 * a key record at all — issuance, rotation and revocation are the keys CLI's,
 * over a read-write handle this process never holds
 * (`v1/keys/sqliteApiKeyStore.ts`).
 *
 * It is a **separate SQLite file from the energy database**, which is 376 GiB,
 * is owned by `energy-data-gathering` and is opened readonly by the private
 * server. `resolveApiKeysDbPath` refuses to start if the two are pointed at the
 * same file. The full reasoning is at the top of `sqliteApiKeyStore.ts`.
 *
 * Opening it before `listen` is deliberate: a misconfigured or missing key
 * store must be a startup failure. The alternative is a process that binds a
 * port and then answers `key_invalid` to every customer, which is the most
 * confusing way this could break.
 */

const PORT = Number(process.env.PUBLIC_PORT) || 3002;
const HOST = process.env.PUBLIC_BIND_HOST || '127.0.0.1';

const apiKeyDirectory = openApiKeyDirectory();
const app = createPublicApp({ apiKeyDirectory });

const server = app.listen(PORT, HOST, () => {
  console.log(`
⚡ Energy Dashboard — PUBLIC API (/v1)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔒 Public composition: internal routes are absent, not filtered
🔑 API-key auth: Authorization: Bearer able_<env>_<prefix>_<secret>
🚀 Listening on http://${HOST}:${PORT}
📊 API base URL: http://${HOST}:${PORT}/v1

Not on this surface, by composition: /api/*, /api/ops/*, /api/health,
/api/dashboard/*, /api/weather/*, and every write/ingest route.
`);
});

// Close the readonly handle on the way out. `config/database.ts` registers the
// same pair for the private app; doing it in the entrypoint rather than inside
// the store module keeps the store a plain object with no global side effects,
// which is what lets `sqliteApiKeyStore.test.ts` open and close a dozen of them
// in one process.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      apiKeyDirectory.close();
      process.exit(0);
    });
  });
}

export default app;
