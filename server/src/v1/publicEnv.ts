/**
 * Build-time configuration for the public composition.
 *
 * Two things live here, both of them decisions the LAN makes easy to get wrong
 * and expensive to unpick later (ABL-291 brief §2):
 *
 * - which environment variables the public process must **not** be given, and
 * - which browser origins it answers, as an allowlist rather than a mirror.
 *
 * Both are pure functions over an env bag so they can be asserted without
 * mutating `process.env` under a concurrently running test file.
 */

/**
 * Environment variables that must be absent from the public process.
 *
 * These are capabilities, not settings. `HELIO_WRITE_TOKEN` is the shared
 * secret that unlocks the two ingest `POST`s (`middleware/writeAuth.ts`);
 * `JAO_CORE_NET_POSITION_ENABLED` arms the JAO capture scheduler;
 * `OPS_PEER_URL` points the combined ops status at a sibling host; `COMMIT_SHA`
 * is baked in at image build and is the git state `/api/health` publishes.
 *
 * None of them is *read* by anything in this composition — that is the point of
 * ABL-304, and the import-graph assertion in `publicApp.test.ts` is what proves
 * it. This list is the second lock: it makes a deployment that hands the public
 * process a write token fail at startup rather than run with a capability
 * nobody meant to grant it. Absent capability beats unused capability, because
 * "unused" is a property of today's code.
 */
export const FORBIDDEN_PUBLIC_ENV = [
  'HELIO_WRITE_TOKEN',
  'JAO_CORE_NET_POSITION_ENABLED',
  'OPS_PEER_URL',
  'COMMIT_SHA',
] as const;

export type PublicEnv = Record<string, string | undefined>;

/**
 * The forbidden variables actually present, in declaration order.
 *
 * "Present" means set to a non-empty string. An explicitly empty value is
 * treated as absent so that a compose file can neutralise an inherited variable
 * with `HELIO_WRITE_TOKEN=` rather than having to unset it, which is awkward to
 * express in Docker's `environment:` block.
 */
export function forbiddenPublicEnvPresent(env: PublicEnv): string[] {
  return FORBIDDEN_PUBLIC_ENV.filter((name) => (env[name] ?? '') !== '');
}

/**
 * Throw unless the environment is clean.
 *
 * The message names the variables and never their values — an error message is
 * the one place a secret reliably ends up in a log file.
 */
export function assertPublicEnvironment(env: PublicEnv): void {
  const present = forbiddenPublicEnvPresent(env);
  if (present.length === 0) return;

  throw new Error(
    `Refusing to build the public app: ${present.join(', ')} ${
      present.length === 1 ? 'is' : 'are'
    } set in this process. The public composition must run with no write or ` +
      'ops capability in its environment (ABL-304). Give the private app those ' +
      'variables instead — it is a separate process.'
  );
}

/**
 * Parse `PUBLIC_CORS_ORIGINS` into an allowlist.
 *
 * Unset or empty yields `[]`, and `[]` is the safe outcome: the `cors` package
 * matches a request origin against the array and emits no
 * `Access-Control-Allow-Origin` header when nothing matches, so no browser
 * origin is granted cross-origin read access by default. Non-browser callers
 * (curl, a server-side SDK) are unaffected — CORS is a browser control, never a
 * server-side one.
 *
 * This replaces `origin: true` + `credentials: true` in `app.ts:72-75`, which
 * reflects whatever `Origin` the caller sent and then permits credentialed
 * requests against it — the combination the brief calls out as the one that
 * must not travel from the LAN build into the public one.
 *
 * Entries are trimmed, blanks dropped, and duplicates collapsed. A trailing
 * slash is stripped because an `Origin` header never carries one, and
 * `https://app.example.com/` in a config file would otherwise match nothing and
 * fail silently at request time rather than loudly here.
 */
export function parsePublicCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const entry of raw.split(',')) {
    const origin = entry.trim().replace(/\/+$/, '');
    if (origin !== '') seen.add(origin);
  }
  return [...seen];
}
