import { createPublicApp } from './publicApp.js';

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
 */

const PORT = Number(process.env.PUBLIC_PORT) || 3002;
const HOST = process.env.PUBLIC_BIND_HOST || '127.0.0.1';

const app = createPublicApp();

app.listen(PORT, HOST, () => {
  console.log(`
⚡ Energy Dashboard — PUBLIC API (/v1)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔒 Public composition: internal routes are absent, not filtered
🚀 Listening on http://${HOST}:${PORT}
📊 API base URL: http://${HOST}:${PORT}/v1

Not on this surface, by composition: /api/*, /api/ops/*, /api/health,
/api/dashboard/*, /api/weather/*, and every write/ingest route.
`);
});

export default app;
