import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Dev server for the templates gallery (lane B2). From packages/ui:
 * `pnpm exec vite --config src/lit/templates/__gallery__/vite.config.mts` (port 3291). Never part of the build.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  esbuild: { jsx: 'automatic' },
  resolve: { extensions: ['.ts', '.tsx', '.js', '.mjs', '.json'] },
  server: { host: '127.0.0.1', port: 3291, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../../../.templates-gallery-dist', import.meta.url)), emptyOutDir: true },
});
