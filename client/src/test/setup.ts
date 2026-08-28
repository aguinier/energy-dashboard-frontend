/**
 * Vitest setup, wired from `client/vite.config.ts` (`test.setupFiles`).
 *
 * Setup files run once per test file, *before* that file's own imports are
 * evaluated. That ordering is the whole point: the zustand persist middleware
 * resolves `localStorage` when `dashboardStore` is imported and never looks
 * again, so anything that fixes the global has to land ahead of the first
 * import — which is why this is a setup file and not a `beforeEach`.
 *
 * See `./memoryStorage.ts` for what is broken and on which Node (ABL-320).
 */
import { installMemoryStorage } from './memoryStorage';

installMemoryStorage();
