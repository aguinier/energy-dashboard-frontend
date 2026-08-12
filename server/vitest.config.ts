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
  },
});
