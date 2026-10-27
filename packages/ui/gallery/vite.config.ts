import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

/** Dev server for the kit gallery. Run from packages/ui: `pnpm gallery` (port 3290). */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  esbuild: { jsx: 'automatic' },
  plugins: [tailwindcss()],
  resolve: {
    // The gallery imports the kit's .ts sources through ".js" specifiers, as the package does.
    extensions: ['.ts', '.tsx', '.js', '.mjs', '.json'],
  },
  server: { host: '127.0.0.1', port: 3290, strictPort: true },
  // No inlined assets: the look gate serves the gallery under the Customer app's policy, whose font-src is 'self' only,
  // so a font inlined as a data: URL would be refused there as it would be in the app.
  build: { outDir: fileURLToPath(new URL('../.gallery-dist', import.meta.url)), emptyOutDir: true, assetsInlineLimit: 0 },
});
