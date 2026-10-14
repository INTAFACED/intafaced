// Test harness only: serves ./harness with the real API keys, Sub-accounts and Fees screens, theme and data layer; the test mocks the API.
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
    port: Number(process.env.TOOLS_HARNESS_PORT ?? 4361),
    strictPort: true,
    fs: { allow: [resolve(here, '../../../../..')] },
  },
  logLevel: 'warn',
});
