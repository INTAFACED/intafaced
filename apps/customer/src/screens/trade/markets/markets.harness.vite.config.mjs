// Test harness only: serves ./harness with the real Markets screen, theme and data layer; the test mocks the API.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: join(here, 'harness'),
  esbuild: { jsx: 'automatic' },
  plugins: [tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.MARKETS_HARNESS_PORT ?? 4366),
    strictPort: true,
    fs: { allow: [resolve(here, '../../../../../..')] },
    // MARKETS_LIVE=1 sends /api to the local test stack's Edge instead of a mock (screenshots on real test data).
    proxy: process.env.MARKETS_LIVE ? { '/api': 'http://127.0.0.1:14500' } : undefined,
  },
  logLevel: 'warn',
});
