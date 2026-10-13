// Test harness only: serves ./harness with the real Home screen and the screen's own data doubles.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: join(here, 'harness'),
  esbuild: { jsx: 'automatic' },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.HOME_HARNESS_PORT ?? 4317),
    strictPort: true,
    fs: { allow: [resolve(here, '../../../../..')] },
  },
  logLevel: 'warn',
});
