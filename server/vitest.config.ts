import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `src/**` is vitest's default discovery for this root. `../scripts/**` is
    // the addition: the repo-root one-off scripts import server config directly
    // (`scripts/postForecastBackfill.ts` -> `config/forecastModels.js`) but sit
    // outside both npm workspaces, so nothing ran their tests. A guard that
    // silently blocked its own script for a whole release (ABL-244) is exactly
    // what an unrun test surface produces.
    include: ['src/**/*.test.ts', '../scripts/**/*.test.ts'],

    // Halt the run with one explanatory error when the compiled better-sqlite3
    // binary cannot load under this Node, rather than letting ~16-24 files fail
    // at import with a `bindings.js` stack that names no assertion (ABL-309).
    globalSetup: ['src/test/nativeAbiPreflight.ts'],
  },
});
