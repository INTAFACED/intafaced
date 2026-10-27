import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { homeBoot } from './src/app/boot';

/**
 * Production guard. `VITE_LOCAL_TEST=1` turns on the dev-only screens (`/dev/features`) in a build. It no longer changes
 * which customer rooms open: no build hides or redirects a room, so the Docker image, `pnpm local:stack` and `vite dev` agree.
 * A build in production mode refuses it unless `INTAFACED_LOCAL_STACK_BUILD=1` is also set, so a stray
 * variable (CI, a Dockerfile, a .env file) can never ship those screens to customers.
 * A bundle that wants the dev screens: `INTAFACED_LOCAL_STACK_BUILD=1 VITE_LOCAL_TEST=1 vite build --outDir <dir>`
 * (`pnpm local:stack` does not set either variable today).
 */
export function assertLocalTestBuildAllowed(mode: string, env: Record<string, string | undefined>): void {
  if (mode !== 'production') return;
  if (!env.VITE_LOCAL_TEST) return;
  if (env.INTAFACED_LOCAL_STACK_BUILD === '1') return;
  throw new Error(
    'VITE_LOCAL_TEST is set in a production build. It switches on dev-only screens. ' +
      'Unset it, or set INTAFACED_LOCAL_STACK_BUILD=1 if this is the local test stack build.',
  );
}

const FONT_FILE = /\.(woff2?|ttf|otf)$/i;

/**
 * Keep font files as real files instead of data: URIs. The Docker image's nginx CSP sets `font-src 'self'`, which blocks
 * data: fonts. Returning undefined keeps Vite's default inline limit for every other asset.
 */
export function assetsInlineLimit(filePath: string): boolean | undefined {
  return FONT_FILE.test(filePath) ? false : undefined;
}

export default defineConfig(({ mode }) => {
  assertLocalTestBuildAllowed(mode, { ...loadEnv(mode, process.cwd(), ['VITE_', 'INTAFACED_']), ...process.env });
  return {
    esbuild: { jsx: 'automatic' },
    plugins: [tailwindcss(), homeBoot()],
    server: {
      proxy: {
        '/api': { target: process.env.CUSTOMER_EDGE_URL ?? 'http://127.0.0.1:4000', changeOrigin: false },
        '/ws': { target: process.env.CUSTOMER_WS_URL ?? 'ws://127.0.0.1:4014', ws: true, rewrite: (path) => path.replace(/^\/ws/, '') },
      },
    },
    build: { target: 'es2022', sourcemap: false, assetsInlineLimit },
  };
});
