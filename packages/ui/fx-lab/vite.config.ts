import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** Light objects lab (not shipped). From packages/ui: `pnpm exec vite --config fx-lab/vite.config.ts`. */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  esbuild: { jsx: 'automatic' },
  resolve: { extensions: ['.ts', '.tsx', '.js', '.mjs', '.json'] },
  server: { host: '127.0.0.1', port: Number(process.env.FX_LAB_PORT ?? 3291), strictPort: true },
  logLevel: 'warn',
});
