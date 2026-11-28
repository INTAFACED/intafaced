import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, runnerImport, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { homeBoot } from './src/app/boot';
import { testBanner } from './deployment/test-banner.mjs';
import { localWorkers } from '../../tooling/scripts/local-jobs.mjs';
import { nodeStorageOff, testResults } from '../../tooling/vitest/budget.mjs';

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

const BETA_SCREENS = fileURLToPath(new URL('./src/app/beta-screens.json', import.meta.url));
const BETA_VOLT = fileURLToPath(new URL('./src/app/beta-volt.ts', import.meta.url));
const NAVIGATION = fileURLToPath(new URL('./src/app/navigation.ts', import.meta.url));

/**
 * The beta's switch (`INTAFACED_BETA_VOLT_ONLY=1`, set only by tooling/beta/beta-host.mjs): the build reads the rooms
 * Order 1's journey steps showed (src/app/beta-screens.json) and gives the app `__BETA_VOLT_ROOMS__`, so the menus and
 * links hide every other room (src/app/beta-volt.ts). Off, nothing is defined and every room shows, as on the test stack and in CI.
 */
export function betaVolt(env: Record<string, string | undefined> = process.env): Plugin {
  const on = env.INTAFACED_BETA_VOLT_ONLY === '1';
  return {
    name: 'intafaced-beta-volt',
    enforce: 'pre',
    config: async () => ({ define: await betaVoltDefine(env) }),
    // On, every module's JSX (the rooms' and the kit's) gets the beta's runtime, which draws no link to a hidden room
    // (src/app/beta-links.ts); that runtime alone reaches React's own. Off, nothing is swapped.
    resolveId: (source, importer) => (on && JSX_RUNTIMES.includes(source) && !importer?.startsWith(BETA_JSX) ? BETA_JSX + source : null),
    load: (id) => (id.startsWith(BETA_JSX) ? betaJsxSource(id.slice(BETA_JSX.length)) : null),
  };
}
const JSX_RUNTIMES = ['react/jsx-runtime', 'react/jsx-dev-runtime'];
const BETA_JSX = '\0intafaced-beta:';
const BETA_LINKS = fileURLToPath(new URL('./src/app/beta-links.ts', import.meta.url));
export function betaJsxSource(runtime: string): string {
  const names = runtime === 'react/jsx-dev-runtime' ? ['jsxDEV'] : ['jsx', 'jsxs'];
  return [
    `import * as real from ${JSON.stringify(runtime)};`,
    `import { betaRuntime } from ${JSON.stringify(BETA_LINKS)};`,
    `const runtime = betaRuntime({ ${names.map((name) => `${name}: real.${name}`).join(', ')}, Fragment: real.Fragment });`,
    ...names.map((name) => `export const ${name} = runtime.${name};`),
    'export const Fragment = runtime.Fragment;',
  ].join('\n');
}
export async function betaVoltDefine(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  if (env.INTAFACED_BETA_VOLT_ONLY !== '1') return {};
  const load = <T>(file: string) =>
    runnerImport<T>(file, { configFile: false, root: fileURLToPath(new URL('.', import.meta.url)), logLevel: 'error' });
  const { module: beta } = await load<typeof import('./src/app/beta-volt')>(BETA_VOLT);
  const { module: navigation } = await load<typeof import('./src/app/navigation')>(NAVIGATION);
  return { __BETA_VOLT_ROOMS__: JSON.stringify(beta.betaRoomList(JSON.parse(readFileSync(BETA_SCREENS, 'utf8')).rooms, navigation.rooms)) };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ['VITE_', 'INTAFACED_']), ...process.env };
  assertLocalTestBuildAllowed(mode, env);
  return {
    esbuild: { jsx: 'automatic' },
    plugins: [tailwindcss(), homeBoot(), testBanner(env), hostDispatchReceipt(), developerDocs(), betaVolt()],
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
    // vitest reads this config too: on a shared machine at most INTAFACED_LOCAL_JOBS workers (tooling/scripts/local-jobs.mjs),
    // and on Node 25+ the workers' own localStorage off, so happy-dom's stands (tooling/vitest/budget.mjs nodeStorageOff),
    // and in CI's Tests job the reporter that records what failed (tooling/vitest/budget.mjs testResults).
    // vitest.render.config.ts merges this, its own execArgv added after.
    test: { ...localWorkers(), ...nodeStorageOff(), ...testResults() },
  };
});
