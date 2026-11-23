/**
 * No workspace package's `test` script compiles into `dist` (flaky #9381; the fix was #9461).
 *
 * CI runs `turbo run test --concurrency=3`, so one package's test starts while another's vitest is reading the first
 * package's `dist`. `@intafaced/contracts`' test was `tsc -p tsconfig.json && vitest run`: its tsc rewrote every
 * `dist/*.js` file under svc-notify's and svc-support's running tests, a half-written file loaded with no exports, and
 * every file of the reading service failed at import (`z.enum(undefined)` in merchant-checkout-branding.ts on main run
 * 44872355939). The type check belongs to the package's `build`, which turbo runs before any test that reads it
 * (turbo.json `<pkg>#test` depends on its own `build`). A `tsc --noEmit` writes nothing and is allowed.
 *
 * Usage: node --test tooling/scripts/test-script-no-emit.test.mjs   (from the repo root; tooling-tests.mjs runs it)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Why a `test` script writes a build into `dist` while other tests run, or null when it does not. */
export function emitsBuild(script) {
  for (const part of script.split(/&&|\|\||;/).map((s) => s.trim())) {
    const tsc = /(^|[\s/])(tsc|tsc\.mjs)(\s|$)/.test(part);
    if (tsc && !/--noEmit\b/.test(part)) return `runs an emitting tsc: \`${part}\``;
    if (/^(pnpm|npm|yarn)(\s+run)?\s+build(\s|$)/.test(part)) return `runs its own build: \`${part}\``;
  }
  return null;
}

function workspaceTestScripts(root = process.cwd()) {
  const found = [];
  for (const top of ['apps', 'services', 'packages', 'tooling']) {
    const dir = join(root, top);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(top, entry.name, 'package.json');
      if (!existsSync(join(root, file))) continue;
      const script = JSON.parse(readFileSync(join(root, file), 'utf8')).scripts?.test;
      if (typeof script === 'string') found.push({ file, script });
    }
  }
  return found;
}

test('the check refuses the scripts that raced, and lets plain test scripts through', () => {
  assert.match(emitsBuild('tsc -p tsconfig.json && vitest run'), /emitting tsc/);
  assert.match(emitsBuild('node ../../tooling/scripts/tsc.mjs -p tsconfig.json && vitest run'), /emitting tsc/);
  assert.match(emitsBuild('pnpm build && vitest run'), /its own build/);
  assert.match(emitsBuild('pnpm run build && vitest run'), /its own build/);
  assert.equal(emitsBuild('vitest run'), null);
  assert.equal(emitsBuild('tsc --noEmit -p tsconfig.json && vitest run'), null);
  assert.equal(emitsBuild('pnpm --filter @intafaced/sbe-codec run build:jar && vitest run'), null);
});

test('no workspace package test script writes dist while other packages test against it', () => {
  const scripts = workspaceTestScripts();
  assert.ok(scripts.length > 20, `found only ${scripts.length} test scripts: run from the repo root`);
  const bad = scripts.flatMap(({ file, script }) => {
    const why = emitsBuild(script);
    return why ? [`${file} ${why}; move the type check to "build" and make turbo.json's <pkg>#test depend on it`] : [];
  });
  assert.deepEqual(bad, []);
});
