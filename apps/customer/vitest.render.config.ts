import type { Plugin } from 'vite';
import { defineConfig, mergeConfig } from 'vitest/config';
import app from './vite.config';

// One time zone and one default language, set before the workers start (they inherit them), so no recording depends on
// the machine's: a date the app formats with the runtime's defaults reads the same on every machine.
process.env.TZ = 'UTC';
process.env.LC_ALL = 'en_US.UTF-8';

const BROWSER = '\0esm-env-browser';

/**
 * number-flow asks esm-env whether it runs in a browser. Vitest's `development` condition answers no, and the hero figure
 * then throws reading a motion preference it never made; here it gets a browser's answer, as it does in the app.
 */
const inTheBrowser: Plugin = {
  name: 'render-record-esm-env-browser',
  enforce: 'pre',
  resolveId: (id) => (id === 'esm-env/browser' ? BROWSER : null),
  load: (id) => (id === BROWSER ? 'export default true;' : null),
};

/**
 * The rendered-output recording (src/app/render-record): every Customer room drawn as the look gate draws it, compared
 * part by part with what main recorded. Its own run, so number-flow renders as a browser renders it.
 */
export default defineConfig((env) =>
  mergeConfig(app(env), {
    plugins: [inTheBrowser],
    test: {
      include: ['src/app/render-record/**/*.compare.tsx'],
      environment: 'happy-dom',
      server: { deps: { inline: ['@number-flow/react', 'number-flow', 'esm-env'] } },
      testTimeout: 120_000,
      // The harness collects each closed part's garbage itself (render-record/harness.tsx renderPart).
      execArgv: ['--expose-gc'],
      // The trade chart's engine draws on a canvas, which happy-dom gives no context or colours; it throws after the
      // room's markup is drawn. Only that engine's own throw is let through: every other error still fails the run.
      onUnhandledError: (error) => !String((error as Error)?.stack ?? '').includes('vendor/lightweight-charts.standalone'),
    },
  }),
);
