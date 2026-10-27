import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * THE OPERATOR CONSOLE'S TESTS.
 *
 * This app has one job that matters — halting things — and one failure mode that
 * matters more than any bug: a control that looks like it worked and did not.
 * So the tests here are not "does the page render". They are:
 *
 *   1. Does a command actually leave this process, with the right credential, at
 *      the right address? (`lib/control-plane-client.test.ts`, `app/api/halt-path.test.ts`)
 *   2. When it cannot, does the console REFUSE rather than pretend?
 *   3. Does the rendered HTML an operator reads at 3am say which of those two
 *      happened? (`components/*.test.tsx`)
 *
 * ── Why `renderToStaticMarkup` and not jsdom ────────────────────────────────
 *
 * Same argument as `apps/web/vitest.config.ts`, and it applies harder here. The
 * bug being guarded against was in the SERVED HTML — a panel reading "ACCEPTING"
 * for a ledger the console had never spoken to. `renderToStaticMarkup` produces
 * exactly that string, so assertions are made against the artefact that would
 * mislead an operator, not against a DOM tree reconstructed from it. It also
 * adds no dependency: jsdom + Testing Library is ~40 packages to assert on a
 * disabled attribute.
 *
 * Effects do not run under it, so components that fetch are split into a
 * container and a pure view (see `components/ledger-ops.tsx`) and the view is
 * rendered directly in each state it can hold.
 *
 * ── `server-only` ──────────────────────────────────────────────────────────
 *
 * `lib/control-plane-client.ts` imports `server-only`, whose entire body is a
 * `throw` under any condition except React's `react-server`. Next sets that
 * condition; Vitest does not, so the import is aliased to an empty module. The
 * marker still does its real job — it is `next build` that enforces it, and
 * nothing here changes that.
 *
 * `include` is narrowed to `src` so a `next build` artefact under `.next` is
 * never collected as a test file.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
  // tsconfig.json says `jsx: preserve` because Next owns the emit. Vitest has no
  // Next in front of it, so the transform is named here instead (Vite 8
  // transforms with Oxc, so the option is `oxc`, not `esbuild`).
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'react' },
  },
  resolve: {
    alias: {
      // The `@/*` alias is Next's, from tsconfig.json. Source uses it; the tests
      // that import that source therefore need it too.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./src/testing/server-only.ts', import.meta.url)),
    },
  },
});
