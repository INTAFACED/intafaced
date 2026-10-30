import { existsSync, readFileSync } from 'node:fs';
import { defineConfig, loadEnv, type Plugin } from 'vite';
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

function isLocalTestReceipt(source: string): boolean {
  try {
    return (JSON.parse(source) as { test?: unknown } | null)?.test === true;
  } catch {
    return false;
  }
}

/**
 * Publishes the host dispatch receipt (`deployment/host-dispatch.json`, written by `deployment/host-dispatch.mjs`) at
 * `/host-dispatch.json`, beside `customer-deployment.json`, when the check has been run before the build. The Help room
 * reads it; with no receipt it shows every host as `host.receipt_missing`, never as served.
 */
export function hostDispatchReceipt(file = new URL('./deployment/host-dispatch.json', import.meta.url)): Plugin {
  return {
    name: 'intafaced-host-dispatch-receipt',
    apply: 'build',
    generateBundle() {
      if (!existsSync(file)) return;
      const source = readFileSync(file, 'utf8');
      // A LOCAL TEST receipt (loopback hosts, `test: true`) is served by the local stack itself and never built in.
      if (isLocalTestReceipt(source)) this.error('deployment/host-dispatch.json is a LOCAL TEST receipt; a build never publishes one');
      this.emitFile({ type: 'asset', fileName: 'host-dispatch.json', source });
    },
  };
}

export default defineConfig(({ mode }) => {
  assertLocalTestBuildAllowed(mode, { ...loadEnv(mode, process.cwd(), ['VITE_', 'INTAFACED_']), ...process.env });
  return {
    esbuild: { jsx: 'automatic' },
    plugins: [tailwindcss(), homeBoot(), hostDispatchReceipt()],
    server: {
      proxy: {
        '/api': { target: process.env.CUSTOMER_EDGE_URL ?? 'http://127.0.0.1:4000', changeOrigin: false },
        '/ws': { target: process.env.CUSTOMER_WS_URL ?? 'ws://127.0.0.1:4014', ws: true, rewrite: (path) => path.replace(/^\/ws/, '') },
      },
    },
    build: { target: 'es2022', sourcemap: false, assetsInlineLimit },
  };
});
