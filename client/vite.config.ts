import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig(({ mode }) => {
  // Where the dev server proxies /api. Defaults to the local API server;
  // set API_PROXY_TARGET in client/.env.local to point acceptance at another
  // backend (e.g. prod at http://192.168.86.36:3001) without a local DB.
  const env = loadEnv(mode, __dirname, '')
  const apiTarget = env.API_PROXY_TARGET || 'http://localhost:3001'

  return {
    plugins: [
      react(),
      mode === 'analyze' && visualizer({
        open: true,
        filename: 'dist/stats.html',
        gzipSize: true,
        brotliSize: true,
      }),
    ].filter(Boolean),
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            // React core - changes rarely
            'vendor-react': ['react', 'react-dom'],
            // Data fetching & state
            'vendor-data': ['@tanstack/react-query', 'zustand', 'axios'],
            // Charting library - largest dependency
            'vendor-recharts': ['recharts'],
            // Map library
            'vendor-maps': ['react-simple-maps'],
            // Animation library
            'vendor-animation': ['framer-motion'],
            // UI components (Radix)
            'vendor-ui': [
              '@radix-ui/react-dialog',
              '@radix-ui/react-dropdown-menu',
              '@radix-ui/react-popover',
              '@radix-ui/react-select',
              '@radix-ui/react-separator',
              '@radix-ui/react-slot',
              '@radix-ui/react-tabs',
              '@radix-ui/react-tooltip',
            ],
            // Utilities
            'vendor-utils': ['date-fns', 'clsx', 'tailwind-merge', 'class-variance-authority'],
          },
        },
      },
      sourcemap: 'hidden',
      cssCodeSplit: true,
      chunkSizeWarningLimit: 500,
    },
    server: {
      port: 5173,
      host: true, // Allow network access
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    test: {
      // The suite stays in vitest's default `node` environment: it is
      // overwhelmingly pure-module, and the one component-test file opts itself
      // into jsdom with a per-file `@vitest-environment` docblock
      // (`src/components/dashboard/LoadTab.test.tsx`).
      //
      // What every file does need is a `localStorage` that works, because
      // `dashboardStore` is a persisted zustand store whose middleware calls
      // `storage.setItem` on every `setState`. The host's own global is not
      // that, and which way it is wrong depends on the Node major — absent on
      // Node 24, present-without-`setItem` on Node 25, and a jsdom environment
      // does not override either. That made the same commit green on one Node
      // and 20 failures on the next (ABL-320). `setup.ts` installs a real one
      // before any test module is imported, which is early enough for the
      // persist middleware; see `src/test/memoryStorage.ts` for the measurements.
      setupFiles: ['./src/test/setup.ts'],
    },
  }
})
