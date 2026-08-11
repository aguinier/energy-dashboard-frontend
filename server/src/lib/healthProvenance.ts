/**
 * Provenance fields for /api/health — distinguish a built container from a
 * working-tree dev server without leaking secrets.
 *
 * Three signals, each independently sufficient:
 *  - `commit`  — COMMIT_SHA env var, baked at image build time via Dockerfile
 *                ARG; null on a dev server that never sets it.
 *  - `runtime` — 'container' when NODE_ENV=production (set unconditionally in
 *                the Dockerfile ENV directive), 'dev' otherwise.
 *  - `db_path` — ENERGY_DB_PATH; /data/energy_dashboard.db inside the
 *                container, a local Windows path on a dev checkout.
 */
export interface HealthProvenance {
  commit: string | null;
  runtime: 'container' | 'dev';
  db_path: string;
}

export function getHealthProvenance(
  env: Record<string, string | undefined> = process.env,
): HealthProvenance {
  return {
    commit: env.COMMIT_SHA ?? null,
    runtime: env.NODE_ENV === 'production' ? 'container' : 'dev',
    db_path: env.ENERGY_DB_PATH ?? '/data/energy_dashboard.db',
  };
}
