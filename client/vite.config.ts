import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig(({ mode }) => ({
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
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
}))
