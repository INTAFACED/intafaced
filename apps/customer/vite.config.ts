import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, runnerImport, type Plugin } from 'vite';
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

const DEVELOPER_FILES = fileURLToPath(new URL('./src/features/developers/developers-files.ts', import.meta.url));
const DEVELOPER_FILE = /^\/developers\/([a-z0-9-]+\.(?:md|txt|json))$/;
const DEVELOPER_TYPE: Record<string, string> = { md: 'text/markdown', txt: 'text/plain', json: 'application/json' };

type DeveloperFilesModule = typeof import('./src/features/developers/developers-files');

/**
 * The developer docs' static files (`/developers/<page>.md`, `llms.txt`, `openapi.json`, `collection.json`), generated
 * from the portal's own copy and route tables (`developers-files.ts`) instead of committed: a build writes them into
 * `dist/developers/`, where nginx serves them, and `vite dev` answers them from the source as it is now. A name the
 * generator does not make falls through, so nginx and the dev server both answer it 404 or with the app as before.
 */
export function developerDocs(): Plugin {
  return {
    name: 'intafaced-developer-docs',
    async generateBundle() {
      const { module } = await runnerImport<DeveloperFilesModule>(DEVELOPER_FILES, {
        configFile: false,
        root: fileURLToPath(new URL('.', import.meta.url)),
        logLevel: 'error',
      });
      for (const [name, source] of Object.entries(module.developerFiles())) {
        this.emitFile({ type: 'asset', fileName: `developers/${name}`, source });
      }
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const name = DEVELOPER_FILE.exec((req.url ?? '').split('?')[0]!)?.[1];
        if (!name) return next();
        try {
          const { developerFiles } = (await server.ssrLoadModule(DEVELOPER_FILES)) as DeveloperFilesModule;
          const body = developerFiles()[name];
          if (body === undefined) return next();
          res.setHeader('content-type', `${DEVELOPER_TYPE[name.split('.').pop()!]}; charset=utf-8`);
          res.end(body);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  assertLocalTestBuildAllowed(mode, { ...loadEnv(mode, process.cwd(), ['VITE_', 'INTAFACED_']), ...process.env });
  return {
    esbuild: { jsx: 'automatic' },
    plugins: [tailwindcss(), homeBoot(), hostDispatchReceipt(), developerDocs()],
    server: {
      proxy: {
        '/api': { target: process.env.CUSTOMER_EDGE_URL ?? 'http://127.0.0.1:4000', changeOrigin: false },
        '/ws': { target: process.env.CUSTOMER_WS_URL ?? 'ws://127.0.0.1:4014', ws: true, rewrite: (path) => path.replace(/^\/ws/, '') },
      },
    },
    // Hidden source maps (no sourceMappingURL in the scripts, so the scripts are byte for byte the same) only when the
    // local test stack asks: the journeys' reach recorder maps the functions a page ran back to source lines with them
    // (tooling/scripts/journey-reach.mjs). Every other build has none.
    build: { target: 'es2022', sourcemap: process.env.INTAFACED_SOURCEMAP === 'hidden' ? 'hidden' : false, assetsInlineLimit },
  };
});
